import type { Draft } from "immer";
import { produce } from "immer";
import { useDebugValue, useSyncExternalStore } from "react";

export type Store<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown>,
> = StoreBase<State> & {
  [K in keyof Actions]: Actions[K];
};
export interface StoreBase<State extends object> {
  $get(): State;
  $getInitialState(): State;

  $set(setter: (prevState: State) => State): void;
  $update(updater: (draft: Draft<State>) => void): void;

  $subscribe<Selected>(subscriber: (value: Selected, prevValue: Selected) => void): () => void;
  $subscribe<Selected>(
    selector: (state: State) => Selected,
    subscriber: (value: Selected, prevValue: Selected) => void,
  ): () => void;
}

type Id<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;

/**
 * A simple store implementation using immer, inspired by `@xstate/store`.
 * @param definition The initial state and actions for the store.
 * @returns
 *
 * @example
 * ```typescript
 * const store = createStore({
 *   // All properties other than ``on` are considered part of the state
 *   // Initial values are set here
 *   name: "Alice",
 *   count: 0,
 *
 *   // All actions goes into the `on` property
 *   on: {
 *     incBy(by: number) {
 *       // The immer draft of the state is available as `this`
 *       this.count += by;
 *     },
 *     inc() {
 *       // You can call other actions from within an action
 *       this.incBy(1); // Or `store.incBy(1)`
 *     },
 *     changeName(name: string) {
 *       this.name = name;
 *     },
 *   },
 * });
 *
 * const state1 = store.$getState();
 * // { name: "Alice", count: 0 }
 *
 * // Transition functions are directly available on the store
 * // (NOTE: `this` binding is automatically handled, no need to worry about it)
 * store.incBy(2);
 *
 * const state2 = store.$getState();
 * // { name: "Alice", count: 2 }
 *
 * // Each action creates a new state with immer
 * console.log(state1 === state2); // false
 * console.log(state1); // { name: "Alice", count: 0 }
 *
 * // Subscribe to changes
 * const unsubscribe = store.$subscribe((state) => state, (state, prevState) => {
 *   console.log("State changed:", state, prevState);
 * });
 *
 * store.incBy(2);
 * // State changed: { name: "Alice", count: 4 } { name: "Alice", count: 2 }
 * store.changeName("Bob");
 * // State changed: { name: "Bob", count: 4 } { name: "Alice", count: 4 }
 * ```
 *
 * @see {@linkcode useSelector} for how to use this store in a React component.
 */
export function createStore<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown> = {},
>(
  definition: State & {
    on?: Actions &
      ThisType<
        StoreBase<Id<Omit<State, "on">>> &
          Draft<Id<Omit<State, "on">>> &
          Readonly<{ [K in keyof Actions]: Actions[K] }>
      >;
  },
): Store<Id<Omit<State, "on">>, Actions> {
  const { on: actions, ...initialState } = definition;

  let _state = initialState as State;
  let _draft: Draft<State> | null = null;

  const listeners: ((state: State, prevState: State) => void)[] = [];
  const triggerListeners = (state: State, prevState: State) => {
    if (state === prevState) return;
    for (const listener of listeners) listener(state, prevState);
  };

  function renameFunction<F extends (...args: never) => unknown>(fn: F, name: string): F {
    return Object.defineProperty(fn, "name", {
      value: name,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }

  /* Base store methods */
  const get = () => _state;
  const getInitialState = () => initialState as State;

  const set = (setter: (prevState: State) => State) => {
    const prevState = _state;
    _state = setter(prevState);
    triggerListeners(_state, prevState);
  };
  const update = (updater: (draft: Draft<State>) => void) => {
    const prevState = _state;
    _state = produce(prevState, (draft) => {
      updater(draft);
    });
    triggerListeners(_state, prevState);
  };

  const subscribe = <Selected>(
    selectorOrSubscriber:
      | ((state: State) => Selected)
      | ((value: Selected, prevValue: Selected) => void),
    subscriber?: (value: Selected, prevValue: Selected) => void,
  ) => {
    const selector: (state: State) => Selected =
      subscriber === undefined ? (state) => state as any : (selectorOrSubscriber as any);
    if (typeof selector !== "function")
      throw new TypeError("The selector to $subscribe must be a function.");
    if (subscriber !== undefined && typeof subscriber !== "function")
      throw new TypeError("The subscriber to $subscribe must be a function.");
    if (subscriber === undefined) subscriber = selectorOrSubscriber as any;

    const listener = (state: State, prevState: State) => {
      const newValue = selector(state);
      const prevValue = selector(prevState);
      if (newValue !== prevValue) subscriber!(newValue, prevValue);
    };
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    };
  };

  const store = {
    $get: get,
    $getInitialState: getInitialState,

    $set: set,
    $update: update,

    $subscribe: subscribe,
  } satisfies StoreBase<State>;

  // Make all methods as read-only
  for (const [key, value] of Object.entries(store))
    Object.defineProperty(store, key, {
      value,
      configurable: true,
      enumerable: true,
      writable: false,
    });

  /* Actions */
  if (!actions) return store as any;

  const helperMethodNames = new Set(Object.keys(store));
  const actionNames = new Set(Object.keys(actions));

  for (const [key, handler] of Object.entries(actions))
    Object.defineProperty(store, key, {
      value: renameFunction((...args: never) => {
        if (_draft) return handler.call(_draft, ...args);
        let result: ReturnType<typeof handler>;
        const prevState = _state;
        _state = produce(prevState, (draft) => {
          _draft = draft;
          result = handler.call(
            new Proxy(
              {},
              {
                get: (_, prop, receiver) => {
                  if (
                    typeof prop === "string" &&
                    (helperMethodNames.has(prop) || actionNames.has(prop))
                  )
                    return (store as any)[prop];

                  if (_draft) return Reflect.get(_draft, prop, receiver);

                  let result: any;
                  const prevState = _state;
                  _state = produce(prevState, (draft) => {
                    _draft = draft;
                    result = Reflect.get(draft, prop, receiver);
                    _draft = null;
                  });
                  triggerListeners(_state, prevState);
                  return result;
                },

                set: (_, prop, value, receiver) => {
                  if (_draft) return Reflect.set(_draft, prop, value, receiver);

                  let success = false;
                  const prevState = _state;
                  _state = produce(prevState, (draft) => {
                    _draft = draft;
                    success = Reflect.set(draft, prop, value, receiver);
                    _draft = null;
                  });
                  triggerListeners(_state, prevState);
                  return success;
                },

                deleteProperty: (_, prop) => {
                  if (_draft) return Reflect.deleteProperty(_draft, prop);

                  let success = false;
                  const prevState = _state;
                  _state = produce(prevState, (draft) => {
                    _draft = draft;
                    success = Reflect.deleteProperty(draft, prop);
                    _draft = null;
                  });
                  triggerListeners(_state, prevState);
                  return success;
                },
              },
            ),
            ...args,
          );
          _draft = null;
        });
        triggerListeners(_state, prevState);
        return result;
      }, key),

      configurable: true,
      enumerable: true,
      // Make all actions as read-only
      writable: false,
    });

  return store as any;
}

/**
 * A hook to subscribe to a store and get the selected value from the state.
 *
 * We recommend using {@linkcode hookify} to create a custom hook for your store instead of
 * using this hook directly, as it is more friendly to React developer tools.
 * @param store The store to subscribe to.
 * @param selector A function that takes the state and returns the selected value.
 * @returns The selected value from the state.
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const count = useSelector(counterStore, (state) => state.count);
 *   const { inc, incBy, reset } = counterStore;
 *   // ...
 * }
 * ```
 */
export function useSelector<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown>,
  Selected,
>(store: Store<State, Actions>, selector: (state: State) => Selected): Selected {
  return useSyncExternalStore(
    (onStoreChange) => store.$subscribe(selector, onStoreChange),
    () => selector(store.$get()),
    () => selector(store.$getInitialState()),
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
 * function MyComponent() {
 *   const count = useCounterStore((state) => state.count);
 *   const { inc, incBy, reset } = counterStore;
 *   // ...
 * }
 * ```
 */
export function hookify<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown>,
>(
  name: string,
  store: Store<State, Actions>,
): <Selected = State>(selector?: (state: State) => Selected) => Selected;
export function hookify<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown>,
>(
  store: Store<State, Actions>,
): <Selected = State>(selector?: (state: State) => Selected) => Selected;
export function hookify<
  State extends object,
  Actions extends Record<string, (...args: never) => unknown>,
>(nameOrStore: string | Store<State, Actions>, store?: Store<State, Actions>) {
  const name = typeof nameOrStore === "string" ? nameOrStore : "anonymous";
  store ??= typeof nameOrStore === "string" ? store : nameOrStore;
  if (!store || typeof store !== "object" || !("$get" in store) || !("$set" in store))
    throw new TypeError("The store must be a valid store created by `createStore`.");

  return Object.defineProperty(
    <Selected = State>(selector?: (state: State) => Selected): Selected => {
      selector ??= (state) => state as unknown as Selected;
      const selectedValue = useSyncExternalStore(
        (onStoreChange) => store.$subscribe(selector, onStoreChange),
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
