import { formatMoney } from "./math.js";

export function testFormatMoney() {
  if (formatMoney(1, "USD") !== "$1.00") throw new Error("format failed");
}
