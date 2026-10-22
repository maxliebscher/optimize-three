export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'playwright-core') return {
    url: new URL('./measure-browser.mjs', import.meta.url).href, shortCircuit: true,
  };
  return nextResolve(specifier, context);
}
