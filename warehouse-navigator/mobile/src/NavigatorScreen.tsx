// Экран навигатора: скан QR-якоря → поиск товара → 2D-карта со стрелкой «вы здесь»,
// целевой ячейкой и линией-маршрутом. Между якорями позиция считается по датчикам
// (PDR): шагомер + курс (компас с компенсацией наклона, фьюжн с гироскопом, отсев
// магнитных аномалий), поза выталкивается из стеллажей по плану (map-matching). Вся
// математика — из @smartstack/warehouse-navigator-core; здесь только UI и датчики.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  type LayoutChangeEvent,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer, Gyroscope, Magnetometer, Pedometer } from 'expo-sensors';
import {
  parseAnchor,
  guidanceRoute,
  nearestMappedCell,
  makeArReference,
  arPose,
  fuseOpticalIntoPdr,
  stepDelta,
  magnitude3,
  isMagneticAnomaly,
  fuseHeadingComplementary,
  smoothHeading,
  tiltCompensatedHeadingDeg,
  magnetometerToHeadingDeg,
  createStepDetector,
  createStillnessDetector,
  createGyroBiasEstimator,
  calibrateStrideScale,
  snapOutOfObstacles,
  MAGNETOMETER_INTERVAL_MS,
  ACCELEROMETER_INTERVAL_MS,
  GYRO_MAX_DT_SEC,
  GYRO_FRESH_MS,
  MAG_BASELINE_EMA,
  MAG_BASELINE_RESET_SAMPLES,
  HEADING_FUSE_ALPHA,
  STEP_LENGTH_M,
  PDR_RESCAN_HINT_M,
  type NavAnchor,
  type Product,
  type ProductLocation,
  type LayoutRect,
  type ArSample,
  type ArReference,
} from '@smartstack/warehouse-navigator-core';
import type { NavDataSource } from './datasource';
import { ArCameraTracker } from './ArScene';

interface Props {
  source: NavDataSource;
  onExit: () => void;
}

export function NavigatorScreen({ source, onExit }: Props): React.ReactElement {
  const [permission, requestPermission] = useCameraPermissions();
  const [anchor, setAnchor] = useState<NavAnchor | null>(null);
  const [livePos, setLivePos] = useState<NavAnchor | null>(null);
  const [scanning, setScanning] = useState(true);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [locations, setLocations] = useState<ProductLocation[]>([]);

  const [pdrMeters, setPdrMeters] = useState(0);
  const [pedometerAvailable, setPedometerAvailable] = useState<boolean | null>(null);
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });
  // Оптика (ARCore/ARKit через ViroReact) — ПОСТОЯННЫЙ фоновый корректор дрейфа PDR
  // (фузия, не отдельный режим): трекер смонтирован всё время, пока есть якорь, и
  // непрерывно выправляет счисление, когда видит ориентиры. `cameraView` — лишь выбор
  // ПОКАЗА (камера-просмотр ↔ карта), он не включает/выключает саму фузию.
  // Требует dev build (см. ArScene/README); в Expo Go оптики нет — остаётся чистый PDR.
  const [cameraView, setCameraView] = useState(false);
  const arRefRef = useRef<ArReference | null>(null); // AR-референс, зафиксированный по якорю
  const livePosRef = useRef<NavAnchor | null>(null); // АВТОРИТЕТНАЯ поза (PDR+оптика пишут синхронно)
  const trackingRef = useRef(false); // надёжен ли оптический трекинг (гейт фузии)
  const lastPublishMsRef = useRef(0); // троттлинг setLivePos (AR-кадры идут 30–60 Гц)
  const lastPublishedRef = useRef<NavAnchor | null>(null); // последняя отрисованная поза (гейт по движению)
  const opticalNoteRef = useRef<string | null>(null); // текущий текст индикатора (анти-дребезг)
  const [opticalNote, setOpticalNote] = useState<string | null>(null); // индикатор работы оптики

  const headingRef = useRef<number>(0);
  const accelRef = useRef<{ x: number; y: number; z: number } | null>(null);
  // Повышение точности PDR:
  const stillRef = useRef(false);          // ZUPT: человек стоит (низкая дисперсия |a|)
  const strideScaleRef = useRef(1);        // персональный масштаб длины шага (калибруется по якорям)
  const pdrSinceAnchorRef = useRef(0);     // пройдено по PDR с последнего якоря (для калибровки)
  const prevAnchorRef = useRef<NavAnchor | null>(null); // якорь, ОТ которого шли (пара для калибровки)
  const opticsTouchedSinceAnchorRef = useRef(false);    // оптика правила позу на отрезке → шаг НЕ калибруем
  // Детекторы покоя/дрейфа гиро ПЕРЕЖИВАЮТ рескан якоря (живут в ref): иначе при каждом
  // скане выученное смещение нуля гироскопа терялось бы и курс снова уползал.
  const stillnessRef = useRef<ReturnType<typeof createStillnessDetector> | null>(null);
  const gyroBiasRef = useRef<ReturnType<typeof createGyroBiasEstimator> | null>(null);
  // План склада в ДВУХ местах: ref читает обработчик шага без ре-рендера, state
  // перерисовывает карту, когда план догрузился (мутация ref сама рендер не вызывает).
  const rectsRef = useRef<LayoutRect[]>([]);
  const [rects, setRects] = useState<LayoutRect[]>([]);
  // Замок против многократного onBarcodeScanned (камера шлёт кадры пачкой).
  const scanLockRef = useRef(false);

  // ── Поиск товара (простой дебаунс) ────────────────────────────────────────────────
  useEffect(() => {
    const q = search.trim();
    if (q === '' || product !== null) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      source
        .searchProducts(q)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [search, product, source]);

  // ── Локации товара + план склада (после выбора товара и якоря) ──────────────────────
  useEffect(() => {
    if (anchor === null || product === null) return;
    let cancelled = false;
    source
      .productLocation(anchor.warehouseId, product.id)
      .then((l) => !cancelled && setLocations(l))
      .catch(() => !cancelled && setLocations([]));
    source
      .layout(anchor.warehouseId)
      .then((r) => {
        if (cancelled) return;
        rectsRef.current = r; // для обработчика шага (map-matching)
        setRects(r); // для перерисовки карты
      })
      .catch(() => {
        if (cancelled) return;
        rectsRef.current = [];
        setRects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [anchor, product, source]);

  // Текст индикатора — только при РЕАЛЬНОЙ смене (анти-дребезг ре-рендера).
  const setNote = useCallback((note: string | null) => {
    if (note === opticalNoteRef.current) return;
    opticalNoteRef.current = note;
    setOpticalNote(note);
  }, []);

  // Единая публикация позы: livePosRef обновляется СИНХРОННО (авторитетный источник
  // для PDR и оптики — нет рассинхрона/гонки двух писателей), а setLivePos (ре-рендер)
  // троттлится. AR-кадры идут 30–60 Гц — без троттла это был бы шторм перерисовок всей
  // карты. force=true для шагов PDR и жёстких снапов оптики (рисуем сразу).
  const publishPose = useCallback((pose: NavAnchor, force = false) => {
    livePosRef.current = pose;
    const now = Date.now();
    if (!force && now - lastPublishMsRef.current < 90) return; // ~11 Гц рендера
    const lp = lastPublishedRef.current;
    const moved =
      !lp ||
      Math.hypot(pose.xM - lp.xM, pose.yM - lp.yM) > 0.02 ||
      Math.abs(pose.headingDeg - lp.headingDeg) > 0.5;
    if (!force && !moved) return; // стоим на месте — не перерисовываем (джиттер оптики гасим)
    lastPublishMsRef.current = now;
    lastPublishedRef.current = pose;
    setLivePos(pose);
  }, []);

  // ── Оптика выправляет дрейф PDR (ARCore/ARKit) ──────────────────────────────────────
  // Сырой замер позы камеры → дрейф-свободная оптическая поза склада (makeArReference на
  // первом замере после якоря, дальше arPose). Затем ФУЗИЯ: оптика мягко подтягивает
  // позу PDR к себе, а при крупном (видимом оптикой) дрейфе выправляет жёстко. PDR при
  // этом продолжает работать (основа), оптика — корректор. Результат выталкиваем из
  // стеллажей по плану, как и шаги PDR.
  // Качество оптического трекинга от ViroReact — гейт фузии.
  const onTracking = useCallback(
    (normal: boolean) => {
      trackingRef.current = normal;
      if (!normal) setNote('оптика не видит ориентиров — ведёт PDR');
    },
    [setNote],
  );

  const onArSample = useCallback(
    (s: ArSample) => {
      if (anchor === null) return;
      if (!trackingRef.current) return; // нет надёжного трекинга — PDR не трогаем
      let ref = arRefRef.current;
      if (ref === null) {
        ref = makeArReference(anchor, s);
        arRefRef.current = ref;
      }
      const optical = arPose(anchor, ref, s);
      const base = livePosRef.current ?? optical;
      const fused = fuseOpticalIntoPdr(
        { xM: base.xM, yM: base.yM, headingDeg: base.headingDeg },
        { xM: optical.xM, yM: optical.yM, headingDeg: optical.headingDeg },
      );
      const snapped = snapOutOfObstacles(
        { xM: fused.pose.xM, yM: fused.pose.yM },
        rectsRef.current,
        0,
      );
      headingRef.current = fused.pose.headingDeg; // PDR продолжит с выправленного оптикой курса
      publishPose(
        {
          warehouseId: anchor.warehouseId,
          xM: snapped.xM,
          yM: snapped.yM,
          headingDeg: fused.pose.headingDeg,
        },
        fused.snapped, // жёсткий снап — рисуем немедленно
      );
      // Оптика вмешалась в позу на этом отрезке → пройденный PDR-путь больше не
      // отражает чистое счисление, и калибровать по нему длину шага нельзя.
      opticsTouchedSinceAnchorRef.current = true;
      if (fused.snapped) {
        setNote(`оптика выправила дрейф ${fused.driftM.toFixed(1)} м`);
        setPdrMeters(0); // дрейф сброшен — счётчик «пройдено по датчикам» обнуляем
      } else if (fused.driftM > 0.5) {
        setNote('оптика подстраивает позицию'); // без числа — иначе дребезг ре-рендера
      } else {
        setNote('оптика держит позицию');
      }
    },
    [anchor, publishPose, setNote],
  );

  // ── Счисление по датчикам (PDR) ────────────────────────────────────────────────────
  // Работает ВСЕГДА (основа позы), в т.ч. при включённой оптике: оптика лишь выправляет
  // его дрейф (см. onArSample). Так при потере оптического трекинга (глухая стена, тьма)
  // навигация не замирает — PDR ведёт дальше, оптика до-выправит, когда снова увидит.
  useEffect(() => {
    if (anchor === null) return;
    let cancelled = false;
    let gyroLastTs = 0;
    let magValid = false;
    let magHeading = headingRef.current;
    let magBaseline = 0;
    let magRejectStreak = 0;
    const stepDetector = createStepDetector();
    const stillness = (stillnessRef.current ??= createStillnessDetector()); // ZUPT-триггер; переживает рескан
    const gyroBias = (gyroBiasRef.current ??= createGyroBiasEstimator());    // дрейф нуля гиро; переживает рескан
    const stepLenQueue: number[] = [];
    let lastStepLen = STEP_LENGTH_M;

    Accelerometer.setUpdateInterval(ACCELEROMETER_INTERVAL_MS);
    const accelSub = Accelerometer.addListener((a) => {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
      accelRef.current = a;
      const mag = magnitude3(a.x, a.y, a.z);
      stillRef.current = stillness.update(mag, Date.now()); // обновляем флаг покоя для ZUPT
      const len = stepDetector.update(mag, Date.now());
      if (len !== null) {
        stepLenQueue.push(len);
        if (stepLenQueue.length > 32) stepLenQueue.shift();
      }
    });

    Magnetometer.setUpdateInterval(MAGNETOMETER_INTERVAL_MS);
    const magSub = Magnetometer.addListener(({ x, y, z }) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      if (Math.hypot(x, y) < 1e-6) return;
      const mag = magnitude3(x, y, z);
      if (magBaseline > 0 && isMagneticAnomaly(mag, magBaseline)) {
        if (++magRejectStreak < MAG_BASELINE_RESET_SAMPLES) return;
      }
      magRejectStreak = 0;
      magBaseline =
        magBaseline <= 0 ? mag : magBaseline * (1 - MAG_BASELINE_EMA) + mag * MAG_BASELINE_EMA;
      const a = accelRef.current;
      magHeading = a
        ? tiltCompensatedHeadingDeg(x, y, z, a.x, a.y, a.z)
        : magnetometerToHeadingDeg(x, y);
      magValid = true;
      const gyroFresh = gyroLastTs > 0 && Date.now() - gyroLastTs < GYRO_FRESH_MS;
      if (!gyroFresh) headingRef.current = smoothHeading(headingRef.current, magHeading);
    });

    Gyroscope.setUpdateInterval(MAGNETOMETER_INTERVAL_MS);
    const gyroSub = Gyroscope.addListener(({ z }) => {
      const now = Date.now();
      const dt = gyroLastTs > 0 ? (now - gyroLastTs) / 1000 : 0;
      gyroLastTs = now;
      if (dt <= 0 || dt > GYRO_MAX_DT_SEC) return;
      if (!Number.isFinite(z)) return;
      // ZUPT: пока стоим — учим смещение нуля гироскопа и вычитаем его. Курс
      // перестаёт «уползать» при стоянии и заметно меньше дрейфит при ходьбе.
      const correctedRate = gyroBias.update(-z, stillRef.current);
      headingRef.current = fuseHeadingComplementary(
        headingRef.current,
        correctedRate,
        dt,
        magHeading,
        magValid ? HEADING_FUSE_ALPHA : 0,
      );
    });

    let pedoSub: { remove: () => void } | null = null;
    let lastSteps = 0;
    let stepsSeeded = false;
    Pedometer.isAvailableAsync()
      .then((available) => {
        if (cancelled) return;
        setPedometerAvailable(available);
        if (!available) return;
        pedoSub = Pedometer.watchStepCount((result) => {
          if (!stepsSeeded) {
            stepsSeeded = true;
            lastSteps = result.steps;
            return;
          }
          const newSteps = result.steps - lastSteps;
          lastSteps = result.steps;
          if (newSteps <= 0) return;
          let dist = 0;
          for (let i = 0; i < newSteps; i++) {
            const next = stepLenQueue.shift();
            if (next !== undefined) lastStepLen = next;
            dist += lastStepLen * strideScaleRef.current; // персональный масштаб шага (калибр. по якорям)
          }
          pdrSinceAnchorRef.current += dist; // копим путь от последнего якоря для калибровки
          const heading = headingRef.current;
          const { dx, dy } = stepDelta(heading, dist);
          // Читаем АВТОРИТЕТНУЮ позу из ref (её мог только что поправить кадр оптики) —
          // не из state, иначе шаг затёр бы коррекцию оптики (гонка двух писателей).
          const prev = livePosRef.current;
          if (prev !== null) {
            const snapped = snapOutOfObstacles(
              { xM: prev.xM + dx, yM: prev.yM + dy },
              rectsRef.current,
              0,
              { xM: prev.xM, yM: prev.yM },
            );
            publishPose(
              { ...prev, xM: snapped.xM, yM: snapped.yM, headingDeg: heading },
              true, // шаг — событие редкое, рисуем сразу
            );
          }
          setPdrMeters((m) => m + dist);
        });
      })
      .catch(() => {
        if (!cancelled) setPedometerAvailable(false);
      });

    return () => {
      cancelled = true;
      accelSub.remove();
      magSub.remove();
      gyroSub.remove();
      pedoSub?.remove();
    };
  }, [anchor, publishPose]);

  function onScan({ data }: { data: string }): void {
    if (scanLockRef.current) return; // уже обработали кадр этой сессии сканирования
    const parsed = parseAnchor(data);
    if (!parsed) return; // не наш QR — игнор
    scanLockRef.current = true;
    // Калибровка длины шага по паре якорей — ТОЛЬКО на чистом, прямом PDR-отрезке:
    //  • оптика на отрезке не вмешивалась (иначе путь не отражает счисление);
    //  • шли примерно ПО ПРЯМОЙ (путь ≈ смещению по прямой) — иначе кривой путь
    //    систематически «укорачивал» бы шаг (любой реальный путь ≥ прямой).
    const prev = prevAnchorRef.current;
    const cur = livePosRef.current; // поза PDR прямо перед сбросом на новый якорь
    if (
      prev !== null &&
      prev.warehouseId === parsed.warehouseId &&
      !opticsTouchedSinceAnchorRef.current &&
      cur !== null
    ) {
      const trueDist = Math.hypot(parsed.xM - prev.xM, parsed.yM - prev.yM);
      const pdrPath = pdrSinceAnchorRef.current;
      const netDisp = Math.hypot(cur.xM - prev.xM, cur.yM - prev.yM);
      if (netDisp > 0 && pdrPath <= netDisp * 1.15) {
        strideScaleRef.current = calibrateStrideScale(trueDist, pdrPath, strideScaleRef.current);
      }
    }
    prevAnchorRef.current = parsed;
    pdrSinceAnchorRef.current = 0;
    opticsTouchedSinceAnchorRef.current = false; // новый отрезок начинается «чистым»
    headingRef.current = parsed.headingDeg;
    arRefRef.current = null; // AR заново зафиксирует референс по новому якорю
    livePosRef.current = parsed; // авторитетная поза сразу (PDR/оптика стартуют отсюда)
    lastPublishedRef.current = parsed;
    setAnchor(parsed);
    setLivePos(parsed);
    setScanning(false);
    setPdrMeters(0);
  }

  function startScanning(): void {
    scanLockRef.current = false; // разрешить новый скан
    setScanning(true);
  }

  const route = useMemo(() => {
    const pose = livePos ?? anchor;
    if (!pose) return null;
    const { target } = nearestMappedCell(pose, locations);
    if (!target) return null;
    // Стрелка выправляется по плану склада: если прямая на ячейку упирается в
    // стеллаж/стену — направление отклоняется в сторону прохода (далёкие препятствия
    // игнорируются). Без плана (rects пуст) — поведение прежнее (прямая на цель).
    return { ...guidanceRoute(pose, target, rects), target };
  }, [livePos, anchor, locations, rects]);

  if (!permission) return <Centered text="Запрос доступа к камере…" />;
  if (!permission.granted) {
    return (
      <Centered text="Для сканирования QR-якоря нужен доступ к камере.">
        <Pressable style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Разрешить камеру</Text>
        </Pressable>
      </Centered>
    );
  }

  // Режим сканирования якоря.
  if (scanning || anchor === null) {
    return (
      <SafeAreaView style={styles.root}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScan}
        />
        <View style={styles.scanOverlay} pointerEvents="box-none">
          <Text style={styles.scanHint}>Наведите камеру на QR-якорь склада</Text>
          {anchor !== null ? (
            <Pressable style={styles.btn} onPress={() => setScanning(false)}>
              <Text style={styles.btnText}>Назад к карте</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={onExit}>
              <Text style={styles.btnText}>Сменить склад</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.searchRow}>
        {product ? (
          <Pressable
            style={styles.pickedChip}
            onPress={() => {
              setProduct(null);
              setLocations([]);
              setSearch('');
            }}
          >
            <Text style={styles.pickedText}>✕ {product.name}</Text>
          </Pressable>
        ) : (
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Поиск товара…"
            autoCorrect={false}
          />
        )}
        <Pressable
          style={[styles.rescanBtn, cameraView ? styles.arBtnOn : null]}
          onPress={() => setCameraView((v) => !v)}
        >
          <Text style={styles.btnText}>{cameraView ? '🗺 Карта' : '📷 Камера'}</Text>
        </Pressable>
        <Pressable style={styles.rescanBtn} onPress={startScanning}>
          <Text style={styles.btnText}>Скан</Text>
        </Pressable>
      </View>

      {!product && results.length > 0 ? (
        <FlatList
          style={styles.results}
          data={results}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <Pressable style={styles.resultRow} onPress={() => setProduct(item)}>
              <Text style={styles.resultName}>{item.name}</Text>
              <Text style={styles.resultSku}>{item.sku}</Text>
            </Pressable>
          )}
        />
      ) : null}

      <View style={styles.mapArea}>
        {/* Оптика — ПОСТОЯННЫЙ фоновый корректор: трекер смонтирован, пока есть якорь,
            и в режиме карты (под ней), и в просмотре-камере. Карта (непрозрачная) лежит
            поверх и скрывает камеру; в просмотре вместо карты — прозрачный оверлей. */}
        {anchor !== null ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <ArCameraTracker onSample={onArSample} onTracking={onTracking} />
          </View>
        ) : null}

        {cameraView ? (
          <View style={styles.arOverlay} pointerEvents="none">
            {route ? (
              <View
                style={[styles.arChevron, { transform: [{ rotate: `${route.relativeDeg}deg` }] }]}
              />
            ) : (
              <Text style={styles.arHint}>Найдите товар — покажу направление</Text>
            )}
          </View>
        ) : (
          <WarehouseMap
            rects={rects}
            cells={locations}
            pose={livePos ?? anchor}
            targetCellId={route?.target.cellId ?? null}
            guidanceBearingDeg={route?.bearingDeg ?? null}
            onLayout={(e: LayoutChangeEvent) =>
              setMapSize({
                width: e.nativeEvent.layout.width,
                height: e.nativeEvent.layout.height,
              })
            }
            size={mapSize}
          />
        )}
      </View>

      <View style={styles.footer}>
        {route ? (
          <>
            <Text style={styles.turn}>{route.turnText}</Text>
            <Text style={styles.dist}>
              до ячейки {route.target.code}: {route.distanceM.toFixed(1)} м
            </Text>
            {route.deflected ? (
              <Text style={styles.hint}>↪ обхожу препятствие по плану склада</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.dist}>
            {product ? 'Ячейка товара не размечена на карте' : 'Найдите товар для маршрута'}
          </Text>
        )}
        {opticalNote ? <Text style={styles.hint}>📷 {opticalNote}</Text> : null}
        {pedometerAvailable === false ? (
          <Text style={styles.warn}>Шагомер недоступен — позиция только по сканам QR</Text>
        ) : null}
        {pdrMeters > PDR_RESCAN_HINT_M ? (
          <Text style={styles.warn}>
            пройдено {pdrMeters.toFixed(0)} м по датчикам — пересканируйте якорь
            {' '}(или наведите камеру на проход — оптика выправит)
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

// ── 2D-карта: стеллажи (серые), ячейки (точки), цель (зелёная), «вы здесь» + стрелка ──
function WarehouseMap(props: {
  rects: LayoutRect[];
  cells: ProductLocation[];
  pose: NavAnchor | null;
  targetCellId: string | null;
  guidanceBearingDeg: number | null;
  size: { width: number; height: number };
  onLayout: (e: LayoutChangeEvent) => void;
}): React.ReactElement {
  const { rects, cells, pose, targetCellId, guidanceBearingDeg, size, onLayout } = props;

  // Границы сцены по всем точкам (ячейки, стеллажи, поза) + поля.
  const bounds = useMemo(() => {
    // Инкрементальные min/max (без Math.min(...spread): на большом плане спред
    // переполнил бы стек аргументов).
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const acc = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const c of cells) {
      if (c.posXM !== null && c.posYM !== null) acc(c.posXM, c.posYM);
    }
    for (const r of rects) {
      acc(r.xM - r.lengthM, r.yM - r.widthM);
      acc(r.xM + r.lengthM, r.yM + r.widthM);
    }
    if (pose) acc(pose.xM, pose.yM);
    if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    const pad = 1.5;
    return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
  }, [rects, cells, pose]);

  const { width, height } = size;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min(width / spanX, height / spanY) || 1;

  // Метры → экран. Y инвертируем (на экране вниз — рост Y).
  const sx = (xM: number): number => (xM - bounds.minX) * scale;
  const sy = (yM: number): number => height - (yM - bounds.minY) * scale;

  return (
    <View style={styles.map} onLayout={onLayout}>
      {width > 0
        ? rects.map((r, i) => {
            const w = Math.abs(r.lengthM) * scale;
            const h = Math.abs(r.widthM) * scale;
            const obstacle = (r.kind ?? 'rack') === 'rack' || r.kind === 'wall';
            return (
              <View
                key={`r${i}`}
                style={[
                  styles.rack,
                  {
                    left: sx(r.xM) - w / 2,
                    top: sy(r.yM) - h / 2,
                    width: w,
                    height: h,
                    backgroundColor: obstacle ? '#cbd5e0' : '#e6fffa',
                  },
                ]}
              />
            );
          })
        : null}

      {width > 0
        ? cells.map((c) =>
            c.posXM !== null && c.posYM !== null ? (
              <View
                key={c.cellId}
                style={[
                  styles.cell,
                  {
                    left: sx(c.posXM) - 5,
                    top: sy(c.posYM) - 5,
                    backgroundColor: c.cellId === targetCellId ? '#2f855a' : '#a0aec0',
                  },
                ]}
              />
            ) : null,
          )
        : null}

      {/* Стрелка-маршрут (зелёная) — КУДА идти: выправлена по плану (обход стен).
          Рисуется под маркером «вы здесь», чтобы синяя стрелка-курс была сверху. */}
      {width > 0 && pose && guidanceBearingDeg !== null ? (
        <View style={[styles.you, { left: sx(pose.xM) - 8, top: sy(pose.yM) - 8 }]}>
          <View
            style={[styles.guideArrow, { transform: [{ rotate: `${guidanceBearingDeg}deg` }] }]}
          />
        </View>
      ) : null}

      {width > 0 && pose ? (
        <View
          style={[
            styles.you,
            { left: sx(pose.xM) - 8, top: sy(pose.yM) - 8 },
          ]}
        >
          <View style={[styles.arrow, { transform: [{ rotate: `${pose.headingDeg}deg` }] }]} />
        </View>
      ) : null}
    </View>
  );
}

function Centered(props: { text: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <SafeAreaView style={[styles.root, styles.centered]}>
      <Text style={styles.centerText}>{props.text}</Text>
      {props.children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  centerText: { fontSize: 16, color: '#333', textAlign: 'center' },
  scanOverlay: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 12,
  },
  scanHint: {
    color: '#fff',
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  searchRow: { flexDirection: 'row', padding: 10, gap: 8, alignItems: 'center' },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: '#111',
  },
  pickedChip: {
    flex: 1,
    backgroundColor: '#ebf8ff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  pickedText: { color: '#2b6cb0', fontWeight: '600' },
  rescanBtn: {
    backgroundColor: '#2b6cb0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  arBtnOn: { backgroundColor: '#2f855a' },
  arOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  arChevron: {
    width: 0,
    height: 0,
    borderLeftWidth: 26,
    borderRightWidth: 26,
    borderBottomWidth: 52,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'rgba(47,133,90,0.92)',
  },
  arHint: {
    color: '#fff',
    fontSize: 15,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  results: { maxHeight: 200, marginHorizontal: 10 },
  resultRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  resultName: { fontSize: 15, color: '#111' },
  resultSku: { fontSize: 12, color: '#888' },
  mapArea: { flex: 1 },
  map: { flex: 1, margin: 10, backgroundColor: '#f7fafc', borderRadius: 8, overflow: 'hidden' },
  rack: { position: 'absolute', borderRadius: 2 },
  cell: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },
  you: { position: 'absolute', width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  arrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 14,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#2b6cb0',
  },
  // Стрелка-маршрут (куда идти, выправлена по плану) — крупнее и зелёная, чтобы
  // отличаться от синей стрелки-курса (куда смотрит телефон).
  guideArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 20,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#2f855a',
  },
  footer: { padding: 14, borderTopWidth: 1, borderTopColor: '#eee', gap: 2 },
  turn: { fontSize: 18, fontWeight: '700', color: '#111' },
  dist: { fontSize: 14, color: '#555' },
  hint: { fontSize: 12, color: '#2f855a', marginTop: 2 },
  warn: { fontSize: 12, color: '#c05621', marginTop: 4 },
  btn: { backgroundColor: '#2b6cb0', borderRadius: 8, paddingHorizontal: 18, paddingVertical: 12 },
  btnGhost: { backgroundColor: 'rgba(0,0,0,0.5)' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
