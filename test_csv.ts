import axios from 'axios';
import readline from 'readline';

async function run() {
  const map = new Map<string, string>();
  console.log("Fetching...");
  const response = await axios({
    method: "get",
    url: "https://images.dhan.co/api-data/api-scrip-master.csv",
    responseType: "stream",
    timeout: 30000
  });

  const rl = readline.createInterface({
    input: response.data,
    crlfDelay: Infinity
  });

  let index = 0;
  let headers: string[] = [];
  for await (const line of rl) {
    if (index === 0) {
      headers = line.split(",").map(h => h.trim());
      index++;
      continue;
    }
    const parts = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = parts[idx]?.trim() || "";
    });

    const symbol = row["SEM_TRADING_SYMBOL"] || row["SEM_CUSTOM_SYMBOL"] || row["SM_SYMBOL_NAME"];
    const id = row["SEM_EXCH_INSTRUMENT_ID"] || row["SEM_SM_ID"] || row["SEM_SMST_SECURITY_ID"];

    if (symbol === "KOTAKBANK" && row["SEM_EXM_EXCH_ID"] === "NSE") {
      console.log(row);
      break;
    }
  }
}
run();
