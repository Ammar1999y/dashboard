// Stands in for `msw/browser` in server bundles (`next.config.js`): msw exports
// it to browsers only, and the worker never starts on the server.
export function setupWorker(): never {
  throw new Error('msw/browser runs only in the browser.');
}
