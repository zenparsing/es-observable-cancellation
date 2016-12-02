## In Defense of Subscriptions

> TLDR; Instead of designing Observable on top of CancelToken, I explore the idea of designing CancelToken on top of Observable.

First, a bit of history.

In early 2015 Jafar Husain and I began working together on a formalization of an Observable API for eventual inclusion in the ECMAScript specification. At that time, I was not using observables in my programming work and I was new to the "Rx" world. The approach that I took was to design the API from the ground up, expressing the spirit of Rx-style observables in a way that harmonized with the existing JavaScript standard library and JavaScript idioms. It was intentionally not a "port" of Rx to JS.

We went through many design iterations (at one point the Observer type looked a lot like the Generator type) but we eventually landed on a design that was very close to the original Rx.NET API. This was no accident. I view our work as a validation of that original design and I’m quite confident that (with a few small tweaks) it would be a successful addition to the JavaScript standard library and DOM.

I also wrote an early draft of the CancelToken API. I was quite certain that cancel tokens were the right API for adding cancellation capabilities to async functions. I was less certain that promises were the right mechanism for adding cancellation handlers, though. At the time, I was aware of the following issues with using `cancelToken.promise`:

- Because promise handlers are never called in the same turn as promise resolution, there is an inevitable delay between cancellation and notification of cancellation. As a result, any code which might possibly be called between cancellation and the corresponding promise handler execution must necessarily perform an explicit test for `cancelToken.reason`.
- There is currently no way to detach a promise handler. A `cancelToken.promise` handler must be written with the knowledge that it may be called long after the enclosing async operation has completed. Additionally, the inability to detach the cancellation handler seems to imply memory leakage. This is especially concerning for cancel tokens, which tend to be shared widely and often outlive the async operations that they are passed to.

However, at the time there didn't appear to be a better solution for cancellation notification.

After writing that early draft of the CancelToken API, I wondered whether Observables could be redesigned as a simple synchronous notification API on top of promises and cancel tokens. I did some experimentation along these lines and it seemed possible. Eventually, though, I abandoned that effort because the workarounds needed to address the issues with cancellation notification (as listed above) felt awkward, and in any case I was convinced that the RxJS community would reject the idea.

Jafar has now fully completed the experiment of re-imaging Observable on top of cancel tokens, and I'm convinced by his work that it is indeed possible to replace subscription objects with cancel tokens without a loss of expressivity (provided that his proposed changes to the cancel token design are accepted). I personally think that there is a net loss in ergonomics for the end user of the API, but it's minor and debatable. Instead of arguing a minor point about the ergonomics of cancel tokens versus subscription objects, I'd like to instead focus on what might be a lost opportunity for crafting a better cancel token API.

Jafar has identified two modifications to the current CancelToken design which are required in order for Observables to be implemented on top of them:

1. CancelToken.race must be modified to propagate the cancellation signal synchronously from the source tokens to the output token.
2. CancelToken.race must not propagate the cancellation signal to the output token if the output token is otherwise collectable by the GC.

(Incidentally, I think that the second change would result in very surprising behavior.)

Did you notice how these changes map perfectly to the issues I identified earlier with `cancelToken.promise`? That’s no accident. While `cancelToken.promise` is perfectly fine for many scenarios, for use cases like Observable (which have strict timing requirements) it is not quite sufficient. It may be possible to fix these issues by making the changes that Jafar has identified. I would like to explore an alternative strategy, though.

Instead of designing Observable on top of CancelToken, what would it look like to design CancelToken on top of Observable? The Observable design would essentially stay the same as it is currently. The `subscribe` method would take an Observer object as its argument and return a Subscription object. We’ll return to the `forEach` method later.

For CancelToken, we would replace the internal promise with an instance of Observable. Instead of `cancelToken.promise`, we would have a `subscribe` method which forwards its arguments to the internal observable instance. If cancellation was already requested for a token, then `subscribe` would immediately invoke the methods of the supplied Observer. This would essentially match the behavior of .NET CancellationTokens.

This neatly solves the two problems stated above. The cancellation signal is propagated synchronously to all observers, eliminating the uncomfortable lag between cancellation and notification. Since a Subscription object is returned from the `subscribe` call, it can be used to detach an observer from the token when it is no longer required.

There was one aspect of this design that I initially found troubling: what happens if a cancellation observer throws an exception? With .NET cancellation tokens, errors are bundled together into a list and rethrown as a composite exception. This doesn't seem right for JavaScript. Instead, we can take inspiration from the EventTarget API: if an observer throws an error, we allow the host to report the error and continue sending the cancellation signal to the remaining observers.

All together, it looks like this:

```js
class CancelToken {

  constructor(fn) {
    this._reason = undefined;

    this._observers = new Set();
    this._observable = new Observable(observer => {
      this._observers.add(observer);
      return () => this._observers.delete(observer);
    });

    fn(msg => {
      if (this._reason === undefined) {
        this._reason = new Cancel(msg);
        this._dispatch();
      }
    });
  }

  _dispatch() {
    for (let observer of Array.from(this._observers.values())) {
      try { observer.next(this._reason) } catch (e) { HostReportErrors(e) }
      try { observer.complete() } catch (e) { HostReportErrors(e) }
    }
    this._observers.clear();
  }

  subscribe(...args) {
    let subscription = this._observable.subscribe(...args);
    if (this._reason !== undefined) this._dispatch();
    return subscription;
  }

  [Symbol.observable]() {
    return this._observable;
  }

  static race(list) {
    return new CancelToken(cancel => {
      for (let token of list) {
        token.subscribe({ next: cancel });
      }
    });
  }

  // reason, throwIfRequested, source, etc...
}
```

Because cancel tokens expose a `Symbol.observable` method, they can be converted directly into Observable instances and used with observable combinators. The implementation of `Observable.prototype.forEach` becomes almost trivial with the use of a common operator, `takeUntil`:


```js
import { takeUntil } from 'observable-tools';

class Observable {

  // subscribe, etc...

  forEach(onNext, cancel) {
    return new Promise((resolve, reject) => {
      if (typeof fn !== "function")
        throw new TypeError(`${ fn } is not a function`);

      let source = this;
      if (cancel) {
        source = takeUntil(source, Observable.from(cancel));
      }

      let subscription;

      source.subscribe({

        start(s) {
          subscription = s;
        },

        next(value) {
          try {
            onNext(value);
          } catch (err) {
            reject(err);
            subscription.unsubscribe();
          }
        },

        error: reject,
        complete: resolve,

      });

    });
  }

}
```

As you can see, `forEach` is implemented without referencing the CancelToken API. It can take any object that provides a `Symbol.observable` method as the cancellation notifier. In this way we avoid any circular dependencies between Observable and CancelToken.

What are the advantages of this design?

- It provides an elegant and straightforward layering of concerns.
- It solves the issues with `cancelToken.promise` when applied to use-cases which are time or memory sensitive without having to invent special behavior for `CancelToken.race`.

What are the disadvantages?

- We've lost some of the desirable properties that arise from using promises to transmit asynchronous results.
  - Synchronous side effects can occur as a result of calling `cancel`.
  - Like all observables, the observer supplied to `cancelToken.subscribe` may be notified synchronously (if cancellation has already been requested).

This may make cancel tokens unsuitable for passing across trust boundaries. One solution to this problem might be to provide a simple combinator which ensures that cancellation handlers are called in a future turn.

```js
function safeToken(source) {
  return new CancelToken(cancel => {
    source.subscribe(reason => {
      // Invoke cancel with an empty stack. Side effects
      // from calling cancellation handlers are isolated
      // to an empty stack.
      Promise.resolve().then(() => cancel(reason));
    });
  });
}

let { token, cancel } = CancelToken.source;
untrustedCode(safeToken(token));
// Side-effects from cancel handlers are now confined
// to an empty stack
cancel();
```
