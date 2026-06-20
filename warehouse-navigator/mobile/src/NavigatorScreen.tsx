// Экран навигатора: скан QR-якоря → поиск товара → 2D-карта со стрелкой «вы здесь»,
// целевой ячейкой и линией-маршрутом. Между якорями позиция считается по датчикам
// (PDR): шагомер + курс (компас с компенсацией наклона, фьюжн с гироскопом, отсев
// магнитных аномалий), поза выталкивается из стеллажей по плану (map-matching). Вся
// математика — из @smartstack/warehouse-navigator-core; здесь только UI и датчики.

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  computeRoute,
  nearestMappedCell,
  stepDelta,
  magnitude3,
  isMagneticAnomaly,
  fuseHeadingComplementary,
  smoothHeading,
  tiltCompensatedHeadingDeg,
  magnetometerToHeadingDeg,
  createStepDetector,
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
} from '@smartstack/warehouse-navigator-core';
import type { NavDataSource } from './datasource';

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

  const headingRef = useRef<number>(0);
  const accelRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const rectsRef = useRef<LayoutRect[]>([]);

  // ── Поиск товара (простой дебаунс) ────────────────────────────────────────────────
  useEffect(() => {
    const q = search.trim();
    if (q === '' || product !== null) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      source.searchProducts(q).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
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
        rectsRef.current = r;
      })
      .catch(() => {
        rectsRef.current = [];
      });
    return () => {
      cancelled = true;
    };
  }, [anchor, product, source]);

  // ── Счисление по датчикам (PDR) ────────────────────────────────────────────────────
  useEffect(() => {
    if (anchor === null) return;
    let cancelled = false;
    let gyroLastTs = 0;
    let magValid = false;
    let magHeading = headingRef.current;
    let magBaseline = 0;
    let magRejectStreak = 0;
    const stepDetector = createStepDetector();
    const stepLenQueue: number[] = [];
    let lastStepLen = STEP_LENGTH_M;

    Accelerometer.setUpdateInterval(ACCELEROMETER_INTERVAL_MS);
    const accelSub = Accelerometer.addListener((a) => {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
      accelRef.current = a;
      const len = stepDetector.update(magnitude3(a.x, a.y, a.z), Date.now());
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
      headingRef.current = fuseHeadingComplementary(
        headingRef.current,
        -z,
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
            dist += lastStepLen;
          }
          const heading = headingRef.current;
          const { dx, dy } = stepDelta(heading, dist);
          setLivePos((prev) => {
            if (prev === null) return prev;
            const snapped = snapOutOfObstacles(
              { xM: prev.xM + dx, yM: prev.yM + dy },
              rectsRef.current,
              0,
              { xM: prev.xM, yM: prev.yM },
            );
            return { ...prev, xM: snapped.xM, yM: snapped.yM, headingDeg: heading };
          });
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
  }, [anchor]);

  function onScan({ data }: { data: string }): void {
    const parsed = parseAnchor(data);
    if (!parsed) return; // не наш QR — игнор
    headingRef.current = parsed.headingDeg;
    setAnchor(parsed);
    setLivePos(parsed);
    setScanning(false);
    setPdrMeters(0);
  }

  const route = useMemo(() => {
    const pose = livePos ?? anchor;
    if (!pose) return null;
    const { target } = nearestMappedCell(pose, locations);
    if (!target) return null;
    return { ...computeRoute(pose, target), target };
  }, [livePos, anchor, locations]);

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
        <Pressable style={styles.rescanBtn} onPress={() => setScanning(true)}>
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

      <WarehouseMap
        rects={rectsRef.current}
        cells={locations}
        pose={livePos ?? anchor}
        targetCellId={route?.target.cellId ?? null}
        onLayout={(e: LayoutChangeEvent) =>
          setMapSize({
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          })
        }
        size={mapSize}
      />

      <View style={styles.footer}>
        {route ? (
          <>
            <Text style={styles.turn}>{route.turnText}</Text>
            <Text style={styles.dist}>
              до ячейки {route.target.code}: {route.distanceM.toFixed(1)} м
            </Text>
          </>
        ) : (
          <Text style={styles.dist}>
            {product ? 'Ячейка товара не размечена на карте' : 'Найдите товар для маршрута'}
          </Text>
        )}
        {pedometerAvailable === false ? (
          <Text style={styles.warn}>Шагомер недоступен — позиция только по сканам QR</Text>
        ) : null}
        {pdrMeters > PDR_RESCAN_HINT_M ? (
          <Text style={styles.warn}>
            пройдено {pdrMeters.toFixed(0)} м по датчикам — пересканируйте якорь
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
  size: { width: number; height: number };
  onLayout: (e: LayoutChangeEvent) => void;
}): React.ReactElement {
  const { rects, cells, pose, targetCellId, size, onLayout } = props;

  // Границы сцены по всем точкам (ячейки, стеллажи, поза) + поля.
  const bounds = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of cells) {
      if (c.posXM !== null && c.posYM !== null) {
        xs.push(c.posXM);
        ys.push(c.posYM);
      }
    }
    for (const r of rects) {
      xs.push(r.xM - r.lengthM, r.xM + r.lengthM);
      ys.push(r.yM - r.widthM, r.yM + r.widthM);
    }
    if (pose) {
      xs.push(pose.xM);
      ys.push(pose.yM);
    }
    if (xs.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    const pad = 1.5;
    return {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad,
      maxY: Math.max(...ys) + pad,
    };
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
  results: { maxHeight: 200, marginHorizontal: 10 },
  resultRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  resultName: { fontSize: 15, color: '#111' },
  resultSku: { fontSize: 12, color: '#888' },
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
  footer: { padding: 14, borderTopWidth: 1, borderTopColor: '#eee', gap: 2 },
  turn: { fontSize: 18, fontWeight: '700', color: '#111' },
  dist: { fontSize: 14, color: '#555' },
  warn: { fontSize: 12, color: '#c05621', marginTop: 4 },
  btn: { backgroundColor: '#2b6cb0', borderRadius: 8, paddingHorizontal: 18, paddingVertical: 12 },
  btnGhost: { backgroundColor: 'rgba(0,0,0,0.5)' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
