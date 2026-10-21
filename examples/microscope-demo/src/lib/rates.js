export async function fetchRates() {
  await new Promise(resolve => setTimeout(resolve, 50));
  return { tax: 0.08 };
}
