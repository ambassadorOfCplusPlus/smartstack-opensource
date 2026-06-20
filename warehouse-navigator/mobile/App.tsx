// Корневой экран: выбор источника данных — ЖИВОЙ (адрес LAN-сервера) или ОФЛАЙН
// (вставить/импортировать снимок склада). После подключения — экран навигатора.

import React, { useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SnapshotError } from '@smartstack/warehouse-navigator-core';
import { RemoteSource, OfflineSource, type NavDataSource } from './src/datasource';
import { NavigatorScreen } from './src/NavigatorScreen';

export default function App(): React.ReactElement {
  const [source, setSource] = useState<NavDataSource | null>(null);
  const [url, setUrl] = useState('http://192.168.1.100:8088');
  const [snapshot, setSnapshot] = useState('');
  const [busy, setBusy] = useState(false);

  async function connectRemote(): Promise<void> {
    setBusy(true);
    try {
      const s = new RemoteSource(url.trim().replace(/\/+$/, ''));
      if (!(await s.ping())) {
        Alert.alert('Нет связи', 'Сервер не отвечает. Проверьте адрес и одну сеть Wi-Fi.');
        return;
      }
      setSource(s);
    } finally {
      setBusy(false);
    }
  }

  function openOffline(): void {
    try {
      setSource(new OfflineSource(snapshot));
    } catch (e) {
      const msg = e instanceof SnapshotError ? e.message : 'Не удалось прочитать снимок';
      Alert.alert('Снимок не загружен', msg);
    }
  }

  if (source) {
    return <NavigatorScreen source={source} onExit={() => setSource(null)} />;
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Навигатор по складу</Text>

        <Text style={styles.section}>Живой режим (по сети)</Text>
        <Text style={styles.hint}>
          Запустите ПК-сервер, телефон в той же сети Wi-Fi. Введите адрес сервера:
        </Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.x.x:8088"
        />
        <Pressable
          style={[styles.btn, busy && styles.btnDisabled]}
          onPress={connectRemote}
          disabled={busy}
        >
          <Text style={styles.btnText}>{busy ? 'Подключение…' : 'Подключиться'}</Text>
        </Pressable>

        <Text style={styles.section}>Офлайн-режим (снимок)</Text>
        <Text style={styles.hint}>
          Вставьте содержимое файла снимка склада (*.whnav.json), экспортированного из
          ПК-клиента:
        </Text>
        <TextInput
          style={[styles.input, styles.area]}
          value={snapshot}
          onChangeText={setSnapshot}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder='{"version":1,"warehouse":{…},…}'
        />
        <Pressable
          style={[styles.btn, styles.btnAlt, !snapshot.trim() && styles.btnDisabled]}
          onPress={openOffline}
          disabled={!snapshot.trim()}
        >
          <Text style={styles.btnText}>Открыть офлайн</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 12, color: '#111' },
  section: { fontSize: 16, fontWeight: '600', marginTop: 18, color: '#111' },
  hint: { fontSize: 13, color: '#555', marginVertical: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
  },
  area: { minHeight: 110, textAlignVertical: 'top' },
  btn: {
    backgroundColor: '#2b6cb0',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  btnAlt: { backgroundColor: '#2f855a' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
