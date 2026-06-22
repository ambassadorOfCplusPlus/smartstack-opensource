// ARCore/ARKit-трекинг позы через ViroReact. Компонент отдаёт «сырые» замеры позы
// камеры (позиция + forward на плоскости пола) и КАЧЕСТВО трекинга наверх; превращение
// в позу склада и слияние с PDR — в NavigatorScreen через чистую математику ядра
// (makeArReference/arPose/fuseOpticalIntoPdr). Здесь только мост к нативному AR-движку.
//
// ВАЖНО: ViroReact — нативный модуль. В Expo Go он НЕ работает: нужен dev build
// (expo-dev-client + `expo run:android`) и config-plugin (см. app.json, mobile/README).
// 2D-режим (PDR по датчикам) работает и без этого.

import * as React from 'react';
import { StyleSheet } from 'react-native';
import {
  ViroARScene,
  ViroARSceneNavigator,
  ViroTrackingStateConstants,
  type ViroCameraTransform,
  type ViroTrackingState,
} from '@reactvision/react-viro';
import type { ArSample } from '@smartstack/warehouse-navigator-core';

// Сцена создаётся Viro как `() => JSX.Element` (без пропсов), поэтому колбэки передаём
// через модульные ссылки, а не через viroAppProps. Один экран-навигатор за раз.
let sampleSink: ((s: ArSample) => void) | null = null;
let trackingSink: ((normal: boolean) => void) | null = null;

function NavScene(): React.ReactElement {
  return (
    <ViroARScene
      onTrackingUpdated={(state: ViroTrackingState) => {
        // Гейт фузии: корректируем PDR ТОЛЬКО при надёжном трекинге. LIMITED/
        // UNAVAILABLE (камера у глухой стены, темно, резкое движение) — не трогаем
        // счисление, иначе оптика внесла бы свой шум вместо коррекции.
        trackingSink?.(state === ViroTrackingStateConstants.TRACKING_NORMAL);
      }}
      onCameraTransformUpdate={(ct: ViroCameraTransform) => {
        const sink = sampleSink;
        if (!sink) return;
        const p = ct.position;
        const f = ct.forward;
        if (!p || !f) return;
        // AR-мир: +x вправо, +z из экрана к пользователю. На плоскости пола берём
        // (x,z) позиции и (x,z) forward — ровно вход ArSample для navigatorAr.
        sink({ x: p[0], z: p[2], fx: f[0], fz: f[2] });
      }}
    />
  );
}

// Фоновый трекер позы: монтирует AR-навигатор Viro и шлёт замеры + качество трекинга.
// Работает как ПОСТОЯННЫЙ корректор (не отдельный режим): держится смонтированным,
// пока есть якорь; рисуется на весь контейнер (нужно для трекинга) — поверх кладётся
// карта (фон) либо оверлей навигации (просмотр-камера).
export function ArCameraTracker({
  onSample,
  onTracking,
}: {
  onSample: (s: ArSample) => void;
  onTracking: (normal: boolean) => void;
}): React.ReactElement {
  React.useEffect(() => {
    sampleSink = onSample;
    trackingSink = onTracking;
    return () => {
      if (sampleSink === onSample) sampleSink = null;
      if (trackingSink === onTracking) trackingSink = null;
    };
  }, [onSample, onTracking]);

  return (
    <ViroARSceneNavigator
      autofocus
      initialScene={{ scene: NavScene }}
      style={StyleSheet.absoluteFill}
    />
  );
}
