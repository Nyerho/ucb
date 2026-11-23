'use strict';

let workerBindings = null;

function configureRuntimeBindings(bindings) {
  workerBindings = bindings || null;
}

function getRuntimeEnv(name) {
  const bound = workerBindings && workerBindings[name];
  if (bound !== undefined && bound !== null && bound !== '') return bound;
  const local = process.env[name];
  return local === undefined || local === '' ? undefined : local;
}

module.exports = { configureRuntimeBindings, getRuntimeEnv };
