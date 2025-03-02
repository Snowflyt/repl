import type { Draft } from "immer";
import { Immer, current, isDraft } from "immer";
import { createProxy, getUntracked, isChanged, trackMemo } from "proxy-compare";
import { useDebugValue, useSyncExternalStore } from "react";

/**
 * Force TypeScript to evaluate {@linkcode T} eagerly.
 *
 * This is just used to make type information more readable on hover.
 */
type Id<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;

type ComputedOptions = Record<
  string,
  // The usage of `any` as return type here is intentional to avoid circular type references.
  // Don’t try to replace with `unknown`.
  // Quite ridiculous, isn’t it? Sometimes seemingly same things are not the same in TypeScript.
  () => any
>;
type ExtractComputedReturns<Computed extends ComputedOptions> = {
  readonly [K in keyof Computed as Computed[K] extends (...args: never) => unknown ? K
  : never]: Computed[K] extends (...args: never) => infer R ? R : never;
};

/**
 * A store that holds a state and actions to update the state.
 *
 * @see {@linkcode createStore} for how to create a store.
 */
export type Store<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
> = StoreBase<State, Computed> & {
  [K in keyof Actions]: Actions[K];
};
export interface ReadonlyStoreBase<State extends object, Computed extends ComputedOptions> {
  /**
   * Get the current state of the store.
   * @returns The current state.
   */
  $get(): Readonly<State & ExtractComputedReturns<Computed>>;
  /**
   * Get the initial state of the store.
   * @returns The initial state.
   */
  $getInitialState(): Readonly<State & ExtractComputedReturns<Computed>>;
}
export interface StoreBase<State extends object, Computed extends ComputedOptions>
  extends ReadonlyStoreBase<State, Computed> {
  /**
   * Set the state of the store with a new state.
   * @param newState The new state to set.
   */
  $set(newState: Readonly<State>): void;
  /**
   * Set the state of the store using a setter function.
   * @param setter A function that takes the previous state and returns the new state.
   */
  $set(setter: (prevState: Readonly<State>) => State): void;
  /**
   * Update the state of the store using an updater function.
   * @param updater A function that takes the immer draft of the state and updates it.
   */
  $update(updater: (draft: Draft<State>) => void): void;

  /**
   * Subscribe to changes in the store.
   * @param subscriber The function to call when the state changes.
   * @returns A function to unsubscribe from the store.
   */
  $subscribe(
    subscriber: (
      value: Readonly<State & ExtractComputedReturns<Computed>>,
      prevValue: Readonly<State & ExtractComputedReturns<Computed>>,
    ) => void,
  ): () => void;
  /**
   * Subscribe to changes of a selected value in the store.
   *
   * Dependencies are automatically tracked in the selector function, so feel free to use selectors
   * like `(state) => ({ foo: state.foo, bar: state.bar })`.
   * @param selector A function that takes the state and returns the selected value.
   * @param subscriber The function to call when the selected value changes.
   * @returns A function to unsubscribe from the store.
   */
  $subscribe<Selected>(
    selector: (state: Readonly<State & ExtractComputedReturns<Computed>>) => Selected,
    subscriber: (value: Selected, prevValue: Selected) => void,
  ): () => void;
}

/**
 * Extract the state type from a {@linkcode Store}.
 */
export type ExtractState<S> = S extends Store<infer State, any, any> ? State : never;

/**
 * A simple store implementation using immer, inspired by `@xstate/store`.
 * @param slice The initial state and actions for the store.
 * @returns
 *
 * @example
 * ```typescript
 * const store = createStore({
 *   // All properties other than `computed` and `actions` are considered part of the state
 *   // Initial values are set here
 *   count: 0,
 *   author: {
 *     books: [
 *       { title: "Book 1", pages: 100 },
 *       { title: "Book 2", pages: 200 },
 *     ],
 *   },
 *
 *   // Computed properties goes into the `computed` property
 *   computed: {
 *     doubleCount() {
 *       return this.count * 2;
 *     },
 *     // Computed properties are cached depending on their auto-tracked dependencies
 *     // For example, `thickBooks` will be recalculated only when `author.books` changes
 *     thickBooks() {
 *       return this.author.books.filter((book) => book.pages > 150);
 *     },
 *   },
 *
 *   // All actions goes into the `actions` property
 *   actions: {
 *     incBy(by: number) {
 *       // The immer draft of the state is available as `this`
 *       this.count += by;
 *       // You can access computed properties as well
 *       // console.log(this.doubleCount);
 *     },
 *     inc() {
 *       // You can call other actions from within an action
 *       this.incBy(1); // Or `store.incBy(1)`
 *     },
 *     addBook(title: string, pages: number) {
 *       this.author.books.push({ title, pages });
 *     },
 *   },
 * });
 *
 * const state1 = store.$get();
 * // { count: 0, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 *
 * // Transition functions are directly available on the store
 * // (NOTE: `this` binding is automatically handled, no need to worry about it)
 * store.incBy(2);
 *
 * const state2 = store.$get();
 * // { count: 2, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 *
 * // Each action creates a new state with immer
 * console.log(state1 === state2); // false
 * console.log(state1); // { count: 0, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 *
 * // Computed properties are cached and only recalculated when their dependencies change
 * console.log(state1.doubleCount === state2.doubleCount); // false
 * console.log(state1.thickBooks === state2.thickBooks); // true
 *
 * // Subscribe to changes
 * const unsubscribe = store.$subscribe((state, prevState) => {
 *   console.log("State changed\nfrom:", prevState, "\nto:", state);
 * });
 *
 * store.inc();
 * // State changed
 * // from: { count: 2, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 * // to: { count: 3, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 * store.addBook("Book 3", 300);
 * // State changed
 * // from: { count: 3, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 * // to: { count: 3, authors: [...], doubleCount: [Getter], thickBooks: [Getter] }
 * ```
 *
 * @see {@linkcode useStore} for how to use this store in a React component.
 */
export function createStore<
  State extends object,
  Computed extends ComputedOptions = {},
  Actions extends Record<string, (...args: never) => unknown> = {},
>(
  slice: State & {
    computed?: Computed &
      ThisType<
        ReadonlyStoreBase<Id<Omit<State, "computed" | "actions">>, Computed> &
          Id<
            Readonly<
              Omit<State, "computed" | "actions"> &
                ExtractComputedReturns<Computed> & {
                  [K in keyof Actions]: Actions[K];
                }
            >
          >
      >;
    actions?: Actions &
      ThisType<
        StoreBase<Id<Omit<State, "computed" | "actions">>, Computed> &
          Id<
            Omit<State, "computed" | "actions"> &
              ExtractComputedReturns<Computed> & {
                readonly [K in keyof Actions]: Actions[K];
              }
          >
      >;
  },
): Store<Id<Omit<State, "computed" | "actions">>, Computed, Actions> {
  type ComputedState = Readonly<State & ExtractComputedReturns<Computed>>;

  const { actions: _actions, computed: _computed, ...initialState } = slice;
  const computed = _computed || ({} as Computed);
  const actions = _actions || ({} as Actions);

  let _state = initialState as Readonly<State>;
  let _computedState!: ComputedState;
  let _draft: Draft<State> | null = null;

  const getInitialState = () => _initialComputedState;

  const listeners = new Set<
    (
      state: Readonly<State & ExtractComputedReturns<Computed>>,
      prevState: Readonly<State & ExtractComputedReturns<Computed>>,
    ) => void
  >();

  const setState = (state: State) => {
    if (Object.is(state, _state)) return;
    const prevState = _computedState;
    _state = state;
    _computedState = snapshotComputedState(state);
    for (const listener of listeners) listener(_computedState, prevState);
  };

  const computedCache = new Map<
    string,
    { state: Readonly<State>; affected: Affected; cachedResult: unknown }
  >();

  const getComputedThis = (computedState: ComputedState, stateProxy?: State) => {
    const get = () => computedState;
    const thisArg = { $get: get, $getInitialState: getInitialState };
    for (const key of Reflect.ownKeys(computedState)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(computedState, key);
      if (!descriptor) continue;
      if (!stateProxy || descriptor.get) {
        Reflect.defineProperty(thisArg, key, descriptor);
      } else {
        const desc = { ...descriptor, get: () => (stateProxy as any)[key] };
        delete desc.value;
        delete desc.writable;
        Reflect.defineProperty(thisArg, key, desc);
      }
    }
    for (const [key, handler] of Object.entries(actions)) {
      const fn = renameFunction((...args: never) => handler.apply(thisArg, args), "key");
      (thisArg as any)[key] = fn;
    }
    return thisArg;
  };

  const snapshotComputedState = (state: State) => {
    const computedState = { ...state } as ComputedState;

    const cache = new Map<string, unknown>();
    for (const [key, { affected, cachedResult, state: prevState }] of computedCache)
      if (!isChanged(prevState, state, affected, new WeakMap(), isOriginalEqual)) {
        touchAffected(state, prevState, affected);
        cache.set(key, cachedResult);
      }

    for (const [key, getter] of Object.entries(computed))
      Object.defineProperty(computedState, key, {
        get: () => {
          if (cache.has(key)) return cache.get(key);

          if (computedCache.has(key)) {
            const { affected, cachedResult, state: cachedState } = computedCache.get(key)!;
            if (!isChanged(cachedState, state, affected, new WeakMap(), isOriginalEqual)) {
              touchAffected(state, cachedState, affected);
              cache.set(key, cachedResult);
              return cachedResult;
            }
          }

          const affected: Affected = new WeakMap();
          const proxy = createProxy(state, affected, undefined, targetCache);
          const thisArg = getComputedThis(computedState, proxy);
          const value = untrack(getter.call(thisArg), new WeakSet());
          touchAffected(state, state, affected);
          // Update to global cache if cache is empty or `state` is still the latest
          // (to avoid corrupt latest computed cache)
          if (
            !computedCache.has(key) ||
            !isChanged(
              state,
              _draft ? current(_draft) : _state,
              affected,
              new WeakMap(),
              isOriginalEqual,
            )
          )
            computedCache.set(key, { state, affected, cachedResult: value });
          cache.set(key, value);
          return value;
        },
        enumerable: true,
      });

    return computedState;
  };

  const _initialComputedState = snapshotComputedState(initialState as State);
  _computedState = _initialComputedState;

  /* Base store methods */
  const get = () => _computedState;

  const set = (newStateOrSetter: State | ((prevState: State) => State)) => {
    if (typeof newStateOrSetter === "function") setState(newStateOrSetter(_state));
    else setState(newStateOrSetter);
  };
  const update = (updater: (draft: Draft<State>) => void) => {
    setState(
      produce(_state, (draft) => {
        updater(draft);
      }),
    );
  };

  const subscribe = <Selected>(
    selectorOrSubscriber:
      | ((state: ComputedState) => Selected)
      | ((value: Selected, prevValue: Selected) => void),
    subscriber?: (value: Selected, prevValue: Selected) => void,
  ) => {
    const selector: (state: ComputedState) => Selected =
      subscriber === undefined ?
        (state) => state as any
      : memoize(selectorOrSubscriber as (state: ComputedState) => Selected);
    if (typeof selector !== "function")
      throw new TypeError("The selector to $subscribe must be a function.");
    if (subscriber !== undefined && typeof subscriber !== "function")
      throw new TypeError("The subscriber to $subscribe must be a function.");
    if (subscriber === undefined) subscriber = selectorOrSubscriber as any;

    const listener = (state: ComputedState, prevState: ComputedState) => {
      const newValue = selector(state);
      const prevValue = selector(prevState);
      if (!Object.is(newValue, prevValue)) subscriber!(newValue, prevValue);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const store = {
    $get: get,
    $getInitialState: getInitialState,

    $set: set,
    $update: update,

    $subscribe: subscribe,
  } satisfies StoreBase<State, Computed>;

  /* Actions */
  const helperMethodNames = new Set(Object.keys(store));
  const computedNames = new Set(Object.keys(computed));
  const actionNames = new Set(Object.keys(actions));

  const getActionThis = () =>
    new Proxy(
      {},
      {
        get: (_, prop, receiver) => {
          if (typeof prop === "string" && (helperMethodNames.has(prop) || actionNames.has(prop)))
            return (store as any)[prop];

          if (typeof prop === "string" && computedNames.has(prop)) {
            const cache = computedCache.get(prop);
            const state = _draft ? (current(_draft) as State) : _state;
            if (
              cache &&
              !isChanged(cache.state, state, cache.affected, new WeakMap(), isOriginalEqual)
            ) {
              touchAffected(state, cache.state, cache.affected);
              return cache.cachedResult;
            }
            const affected: Affected = new WeakMap();
            const proxy = createProxy(state, affected, undefined, targetCache);
            const thisArg = getComputedThis(_computedState, proxy);
            const value = untrack(computed[prop as keyof Computed]!.call(thisArg), new WeakSet());
            touchAffected(state, state, affected);
            computedCache.set(prop, { state, affected, cachedResult: value });
            return value;
          }

          if (_draft) return Reflect.get(_draft, prop, receiver);

          let result: any;
          setState(
            produce(_state, (draft) => {
              _draft = draft;
              result = Reflect.get(draft, prop, receiver);
              if (isDraft(result)) result = current(result);
              _draft = null;
            }),
          );
          return result;
        },

        set: (_, prop, value, receiver) => {
          if (_draft) return Reflect.set(_draft, prop, value, receiver);

          let success = false;
          setState(
            produce(_state, (draft) => {
              _draft = draft;
              success = Reflect.set(draft, prop, value, receiver);
              _draft = null;
            }),
          );
          return success;
        },

        deleteProperty: (_, prop) => {
          if (_draft) return Reflect.deleteProperty(_draft, prop);

          let success = false;
          setState(
            produce(_state, (draft) => {
              _draft = draft;
              success = Reflect.deleteProperty(draft, prop);
              _draft = null;
            }),
          );
          return success;
        },
      },
    );

  for (const [key, handler] of Object.entries(actions))
    (store as any)[key] = renameFunction((...args: never) => {
      if (_draft) return handler.apply(getActionThis(), args);
      let result: ReturnType<typeof handler>;
      setState(
        produce(_state, (draft) => {
          _draft = draft;
          result = handler.apply(getActionThis(), args);
          _draft = null;
        }),
      );
      return result;
    }, key);

  return Object.freeze(store) as any;
}

/*********
 * Slice *
 *********/
/**
 * A slice of a {@linkcode Store}.
 */
export type Slice<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
> = State & {
  computed?: Computed;
  actions?: Actions;
};

/**
 * Create a slice for a store.
 *
 * This function just returns the input slice as is, but it is useful for type inference.
 * @param slice The slice for the store.
 * @returns
 */
export function createSlice<
  State extends object,
  Computed extends ComputedOptions = {},
  Actions extends Record<string, (...args: never) => unknown> = {},
>(
  slice: State & {
    computed?: Computed &
      ThisType<
        ReadonlyStoreBase<Id<Omit<State, "computed" | "actions">>, Computed> &
          Id<
            Readonly<
              Omit<State, "computed" | "actions"> &
                ExtractComputedReturns<Computed> & {
                  [K in keyof Actions]: Actions[K];
                }
            >
          >
      >;
    actions?: Actions &
      ThisType<
        StoreBase<Id<Omit<State, "computed" | "actions">>, Computed> &
          Id<
            Omit<State, "computed" | "actions"> &
              ExtractComputedReturns<Computed> & {
                readonly [K in keyof Actions]: Actions[K];
              }
          >
      >;
  },
): Id<
  State &
    ([keyof Computed] extends [never] ? {} : { computed: Computed }) &
    ([keyof Actions] extends [never] ? {} : { actions: Actions })
> {
  return slice as any;
}

type MergeSlices<Slices> =
  _MergeSlices<Slices> extends (
    {
      state: infer State;
      computed: infer Computed;
      actions: infer Actions;
    }
  ) ?
    Id<
      State &
        ([keyof Computed] extends [never] ? {} : { computed: Computed }) &
        ([keyof Actions] extends [never] ? {} : { actions: Actions })
    >
  : never;
type _MergeSlices<
  Slices,
  Acc extends {
    state: object;
    computed: ComputedOptions;
    actions: Record<string, (...args: never) => unknown>;
  } = { state: {}; computed: {}; actions: {} },
> =
  Slices extends [infer S, ...infer Rest] ?
    _MergeSlices<
      Rest,
      {
        state: Id<Acc["state"] & Omit<S, "computed" | "actions">>;
        computed: Id<Acc["computed"] & ("computed" extends keyof S ? S["computed"] : {})>;
        actions: Id<Acc["actions"] & ("actions" extends keyof S ? S["actions"] : {})>;
      }
    >
  : Acc;

/**
 * Merge multiple slices into a single slice.
 * @param slices The slices to merge.
 * @returns
 */
export function withSlices<Slices extends Slice<any, any, any>[]>(
  ...slices: Slices
): MergeSlices<Slices> {
  const state = {};
  const computed = {};
  const actions = {};

  for (const slice of slices) {
    Object.assign(state, slice);
    Object.assign(computed, slice.computed);
    Object.assign(actions, slice.actions);
  }

  return { ...state, computed, actions } as any;
}

/*********
 * React *
 *********/
/**
 * A hook to subscribe to a store and get the selected value from the state.
 *
 * Dependencies are automatically tracked in the selector function, so feel free to use selectors
 * like `(state) => ({ foo: state.foo, bar: state.bar })`.
 *
 * We recommend using {@linkcode hookify} to create a custom hook for your store instead of
 * using this hook directly, as it is more friendly to React developer tools.
 * @param store The store to subscribe to.
 * @param selector A function that takes the state and returns the selected value.
 * @returns The selected value from the state.
 *
 * @example
 * ```typescript
 * function Counter() {
 *   const count = useStore(counterStore, (state) => state.count);
 *   const { inc, incBy, reset } = counterStore;
 *   // ...
 * }
 *
 * function AnotherComponent() {
 *   const [foo, bar] = useStore(myStore, (state) => [state.foo, state.bar]);
 *   const { baz, qux } = useStore(myStore, (state) => ({ baz: state.baz, qux: state.qux }));
 *   // ...
 * }
 * ```
 */
export function useStore<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
  const Selected = State,
>(
  store: Store<State, Computed, Actions>,
  selector?: (state: Id<Readonly<State & ExtractComputedReturns<Computed>>>) => Selected,
): Selected {
  selector = selector ? memoize(selector) : (state) => state as unknown as Selected;
  return useSyncExternalStore(
    // eslint-disable-next-line @typescript-eslint/unbound-method
    store.$subscribe,
    () => selector(store.$get() as any),
    () => selector(store.$getInitialState() as any),
  );
}

/**
 * Create a React hook that can be used to subscribe to a store and get the selected value from the
 * state.
 * @param name A name for the hook, used for debugging purposes.
 * @param store The store to subscribe to.
 * @returns The hook that can be used to subscribe to the store.
 *
 * @example
 * ```typescript
 * const useCounterStore = hookify("counter", counterStore);
 *
 * function Counter() {
 *   const count = useCounterStore((state) => state.count);
 *   const { inc, incBy, reset } = counterStore;
 *   // ...
 * }
 *
 * const useMyStore = hookify("my", myStore);
 *
 * function MyComponent() {
 *   const [foo, bar] = useMyStore((state) => [state.foo, state.bar]);
 *   const { baz, qux } = useMyStore((state) => ({ baz: state.baz, qux: state.qux }));
 *   // ...
 * }
 * ```
 */
export function hookify<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
>(
  name: string,
  store: Store<State, Computed, Actions>,
): <const Selected = State>(
  selector?: (state: Id<Readonly<State & ExtractComputedReturns<Computed>>>) => Selected,
) => Selected;
export function hookify<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
>(
  store: Store<State, Computed, Actions>,
): <const Selected = State>(
  selector?: (state: Id<Readonly<State & ExtractComputedReturns<Computed>>>) => Selected,
) => Selected;
export function hookify<
  State extends object,
  Computed extends ComputedOptions,
  Actions extends Record<string, (...args: never) => unknown>,
>(nameOrStore: string | Store<State, Computed, Actions>, store?: Store<State, Computed, Actions>) {
  const name = typeof nameOrStore === "string" ? nameOrStore : "anonymous";
  store = store || typeof nameOrStore === "string" ? store : nameOrStore;
  if (!store || typeof store !== "object" || !("$get" in store) || !("$set" in store))
    throw new TypeError("The store must be a valid store created by `createStore`.");

  return Object.defineProperty(
    <Selected = State>(
      selector?: (state: Readonly<State & ExtractComputedReturns<Computed>>) => Selected,
    ): Selected => {
      selector = selector ? memoize(selector) : (state) => state as unknown as Selected;
      const selectedValue = useSyncExternalStore(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        store.$subscribe,
        () => selector(store.$get()),
        () => selector(store.$getInitialState()),
      );
      useDebugValue(selectedValue);
      return selectedValue;
    },
    "name",
    {
      value: `use${(name[0] || "").toUpperCase()}${name.slice(1)}Store`,
      configurable: true,
    },
  );
}

/**********************
 * Internal utilities *
 **********************/
const immer = new Immer();
immer.setAutoFreeze(false); // Enable nested proxies for proxy-compare
const { produce } = immer;

/**
 * Rename a function for better debugging experience.
 * @param fn The function to rename.
 * @param name The new name for the function.
 * @returns The renamed function.
 */
const renameFunction = <F extends (...args: never) => unknown>(fn: F, name: string): F =>
  Object.defineProperty(fn, "name", {
    value: name,
    configurable: true,
  });

/**
 * Memoize a function that takes a state object and returns a result.
 *
 * This is mainly used to memoize selectors in this library.
 * @param fn The function to memoize.
 * @returns The memoized function.
 */
const memoize = <State extends object, R>(fn: (state: State) => R) => {
  let cache = null as { state: State; affected: Affected; cachedResult: R } | null;
  return (state: State) => {
    if (cache) {
      const { affected, cachedResult, state: prevState } = cache;
      if (!isChanged(prevState, state, affected, new WeakMap(), isOriginalEqual)) {
        touchAffected(state, prevState, affected);
        return cachedResult;
      }
    }
    const affected: Affected = new WeakMap();
    const proxy = createProxy(state, affected, undefined, targetCache);
    const result = untrack(fn(proxy), new WeakSet());
    touchAffected(state, state, affected);
    cache = { state, affected, cachedResult: result };
    return result;
  };
};

//------------------------------------------------------------------------------
// The following code snippet is copied from proxy-memoize
// https://github.com/dai-shi/proxy-memoize/blob/cd2bdfecb3ff2a5389063fea7504a8f264c6ec68/src/memoize.ts

// This is required only for performance.
// https://github.com/dai-shi/proxy-memoize/issues/68
const targetCache = new WeakMap();

// constants from proxy-compare
const HAS_KEY_PROPERTY = "h";
const ALL_OWN_KEYS_PROPERTY = "w";
const HAS_OWN_KEY_PROPERTY = "o";
const KEYS_PROPERTY = "k";

type HasKeySet = Set<string | symbol>;
type HasOwnKeySet = Set<string | symbol>;
type KeysSet = Set<string | symbol>;
type Used = {
  [HAS_KEY_PROPERTY]?: HasKeySet;
  [ALL_OWN_KEYS_PROPERTY]?: true;
  [HAS_OWN_KEY_PROPERTY]?: HasOwnKeySet;
  [KEYS_PROPERTY]?: KeysSet;
};
type Affected = WeakMap<object, Used>;

const trackMemoUntrackedObjSet = new WeakSet<object>();

const isObject = (x: unknown): x is object => typeof x === "object" && x !== null;

const untrack = <T>(x: T, seen: WeakSet<object>): T => {
  if (!isObject(x)) return x;
  const untrackedObj = getUntracked(x);
  if (untrackedObj) {
    trackMemo(x);
    trackMemoUntrackedObjSet.add(untrackedObj);
    return untrackedObj;
  }
  if (!seen.has(x)) {
    seen.add(x);
    Object.entries(x).forEach(([k, v]) => {
      const vv = untrack(v, seen);
      if (!Object.is(vv, v)) x[k as keyof T] = vv;
    });
  }
  return x;
};

const touchAffected = (dst: unknown, src: unknown, affected: Affected) => {
  if (!isObject(dst) || !isObject(src)) return;
  const untrackedObj = getUntracked(src);
  const used = affected.get(untrackedObj || src);
  if (!used) {
    if (trackMemoUntrackedObjSet.has(untrackedObj as never)) {
      trackMemo(dst);
    }
    return;
  }
  used[HAS_KEY_PROPERTY]?.forEach((key) => {
    Reflect.has(dst, key);
  });
  if (used[ALL_OWN_KEYS_PROPERTY] === true) {
    Reflect.ownKeys(dst);
  }
  used[HAS_OWN_KEY_PROPERTY]?.forEach((key) => {
    Reflect.getOwnPropertyDescriptor(dst, key);
  });
  used[KEYS_PROPERTY]?.forEach((key) => {
    touchAffected(dst[key as keyof typeof dst], src[key as keyof typeof src], affected);
  });
};

const isOriginalEqual = (x: unknown, y: unknown): boolean => {
  for (let xx = x; xx; x = xx, xx = getUntracked(xx));
  for (let yy = y; yy; y = yy, yy = getUntracked(yy));
  return Object.is(x, y);
};
