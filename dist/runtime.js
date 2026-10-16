// Bound both browser storage and response-body reads. Mobile web apps can resume
// with a native operation still pending even though the page itself is running.
export function deadline(promise, milliseconds, message, expired = () => {}) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new Error(message); error.name = 'TimeoutError';
      reject(error);
      try { expired(); } catch {}
    }, milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
