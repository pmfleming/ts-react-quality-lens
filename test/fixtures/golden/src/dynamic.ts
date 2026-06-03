const target = "./lib/math.js";

export async function loadDynamic() {
  return import(target);
}
