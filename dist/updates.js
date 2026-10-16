export function watchUpdates(registration, workerContainer, { ready, changed }) {
  const seen = new WeakSet();
  let controlled = !!workerContainer.controller;
  const onControllerChange = () => { if (controlled) changed(); controlled = true; };
  const inspect = () => {
    if (registration.waiting && workerContainer.controller) ready(registration.waiting);
    const installing = registration.installing;
    if (installing && !seen.has(installing)) {
      seen.add(installing);
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && workerContainer.controller) ready(registration.waiting || installing);
      });
    }
  };
  registration.addEventListener('updatefound', inspect);
  workerContainer.addEventListener('controllerchange', onControllerChange);
  inspect();
  return () => { registration.removeEventListener('updatefound', inspect); workerContainer.removeEventListener('controllerchange', onControllerChange); };
}
