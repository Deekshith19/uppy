module.exports = class RateLimitedQueue {
  constructor (limit) {
    if (typeof limit !== 'number' || limit === 0) {
      this.limit = Infinity
    } else {
      this.limit = limit
    }

    this.activeRequests = 0
    this.queuedHandlers = []
  }

  _call (fn) {
    this.activeRequests += 1

    let done = false

    let cancelActive
    try {
      cancelActive = fn()
    } catch (err) {
      this.activeRequests -= 1
      throw err
    }

    return {
      abort: () => {
        if (done) return
        done = true
        this.activeRequests -= 1
        cancelActive()
        this._queueNext()
      },

      done: () => {
        if (done) return
        done = true
        this.activeRequests -= 1
        this._queueNext()
      }
    }
  }

  _queueNext () {
    // Do it soon but not immediately, this allows clearing out the entire queue synchronously
    // one by one without continuously _advancing_ it (and starting new tasks before immediately
    // aborting them)
    Promise.resolve().then(() => {
      this._next()
    })
  }

  _next () {
    if (this.activeRequests >= this.limit) {
      return
    }
    if (this.queuedHandlers.length === 0) {
      return
    }

    // Dispatch the next request, and update the abort/done handlers
    // so that cancelling it does the Right Thing (and doesn't just try
    // to dequeue an already-running request).
    const next = this.queuedHandlers.shift()
    const handler = this._call(next.fn)
    next.abort = handler.abort
    next.done = handler.done
  }

  _queue (fn) {
    const handler = {
      fn,
      abort: () => {
        this._dequeue(handler)
      },
      done: () => {
        throw new Error('Cannot mark a queued request as done: this indicates a bug')
      }
    }
    this.queuedHandlers.push(handler)
    return handler
  }

  _dequeue (handler) {
    const index = this.queuedHandlers.indexOf(handler)
    if (index !== -1) {
      this.queuedHandlers.splice(index, 1)
    }
  }

  run (fn) {
    if (this.activeRequests < this.limit) {
      return this._call(fn)
    }
    return this._queue(fn)
  }

  wrapPromiseFunction (fn) {
    return (...args) => new Promise((resolve, reject) => {
      const queuedRequest = this.run(() => {
        let cancelError
        fn(...args).then((result) => {
          if (cancelError) {
            reject(cancelError)
          } else {
            queuedRequest.done()
            resolve(result)
          }
        }, (err) => {
          if (cancelError) {
            reject(cancelError)
          } else {
            queuedRequest.done()
            reject(err)
          }
        })

        return () => {
          cancelError = new Error('Cancelled')
        }
      })
    })
  }
}
