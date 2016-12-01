const Observable = require('zen-observable');

function HostReportErrors(...errors) {
  for (let error of errors) {
    console.error(error);
  }
}

class Cancel {
  constructor(msg) {
    this._msg = String(msg);
  }
}

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

  get reason() {
    return this._reason;
  }

  throwIfRequested() {
    if (this._reason !== undefined) {
      throw this._reason;
    }
  }

  static race(list) {
    return new CancelToken(cancel => {
      for (let token of list) {
        token.subscribe(cancel);
      }
    });
  }

  static source() {
    let source = {};
    source.token = new this(cancel => source.cancel = cancel);
    return source;
  }
}


exports.CancelToken = CancelToken;
