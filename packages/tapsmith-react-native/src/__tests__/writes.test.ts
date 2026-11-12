import { describe, expect, it, vi } from 'vitest';
import { markTapsmithWrite, persistedWriteCount, subscribePersistedWrites, trackStoreWrites } from '../writes.js';

describe('persisted write tracking', () => {
  it('counts every write method an AsyncStorage-shaped store exposes, and nothing it reads', async () => {
    const store = {
      getItem: vi.fn(async () => 'v'),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
      mergeItem: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      multiGet: vi.fn(async () => []),
      multiSet: vi.fn(async () => undefined),
      multiRemove: vi.fn(async () => undefined),
      multiMerge: vi.fn(async () => undefined),
      getAllKeys: vi.fn(async () => []),
    };
    const tracking = trackStoreWrites([store]);
    expect(tracking.trackable).toBe(true);
    const start = persistedWriteCount();
    await store.getItem();
    await store.multiGet();
    await store.getAllKeys();
    expect(persistedWriteCount()).toBe(start);
    await store.setItem();
    await store.removeItem();
    await store.mergeItem();
    await store.clear();
    await store.multiSet();
    await store.multiRemove();
    await store.multiMerge();
    expect(persistedWriteCount()).toBe(start + 7);
    tracking.untrack();
  });

  it('wraps methods inherited from a class (MMKV) and keeps `this`', () => {
    class Kv {
      data = new Map<string, string>();
      set(k: string, v: string): void { this.data.set(k, v); }
      getString(k: string): string | undefined { return this.data.get(k); }
      delete(k: string): void { this.data.delete(k); }
      clearAll(): void { this.data.clear(); }
    }
    const kv = new Kv();
    const tracking = trackStoreWrites([kv]);
    const start = persistedWriteCount();
    kv.set('a', '1');
    expect(kv.getString('a')).toBe('1');
    kv.delete('a');
    kv.clearAll();
    expect(persistedWriteCount()).toBe(start + 3);
    tracking.untrack();
    // Untracked: the class's own methods are back, and writes no longer count.
    expect(Object.prototype.hasOwnProperty.call(kv, 'set')).toBe(false);
    kv.set('b', '2');
    expect(persistedWriteCount()).toBe(start + 3);
  });

  it('counts the write verbs of other stores, and leaves listener registration alone', () => {
    const realmLike = {
      objects: () => [],
      write: (fn: () => void) => fn(),
      create: () => undefined,
      delete: () => undefined,
      addListener: () => undefined,
    };
    const tracking = trackStoreWrites([realmLike]);
    const start = persistedWriteCount();
    realmLike.addListener();
    realmLike.objects();
    expect(persistedWriteCount()).toBe(start);
    realmLike.write(() => realmLike.create());
    expect(persistedWriteCount()).toBe(start + 2);
    tracking.untrack();
  });

  it('restores an own method that was there before', async () => {
    const original = vi.fn(async () => undefined);
    const store = { setItem: original };
    const tracking = trackStoreWrites([store]);
    expect(store.setItem).not.toBe(original);
    tracking.untrack();
    expect(store.setItem).toBe(original);
  });

  it('counts a write even when the store call throws', () => {
    const store = { setItem: () => { throw new Error('disk full'); } };
    const tracking = trackStoreWrites([store]);
    const start = persistedWriteCount();
    expect(() => store.setItem()).toThrow('disk full');
    expect(persistedWriteCount()).toBe(start + 1);
    tracking.untrack();
  });

  it('reports a store it cannot wrap as untrackable', () => {
    const frozen = Object.freeze({ setItem: () => undefined });
    expect(trackStoreWrites([frozen]).trackable).toBe(false);
    // Nothing that writes: there is nothing to track either.
    expect(trackStoreWrites([{ getItem: () => undefined }]).trackable).toBe(false);
  });

  it('reports a store that writes through statements or file operations as untrackable, whatever else it has', () => {
    // op-sqlite: `updateHook` matches a write name, but writes go through `execute`.
    const sqlite = { execute: () => undefined, updateHook: () => undefined, close: () => undefined };
    expect(trackStoreWrites([sqlite]).trackable).toBe(false);
    const files = { deleteAsync: () => undefined, downloadAsync: () => undefined };
    expect(trackStoreWrites([files]).trackable).toBe(false);
  });

  it('counts manual marks and tells subscribers', () => {
    const seen: number[] = [];
    const off = subscribePersistedWrites((n) => seen.push(n));
    const start = persistedWriteCount();
    markTapsmithWrite();
    markTapsmithWrite();
    expect(persistedWriteCount()).toBe(start + 2);
    expect(seen).toEqual([start + 1, start + 2]);
    off();
    markTapsmithWrite();
    expect(seen).toEqual([start + 1, start + 2]);
  });
});
