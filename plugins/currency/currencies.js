import { CRYPTO_ALIASES, FIAT_ALIASES } from "./aliases.js";

// Currency data: the ISO 4217 codes that open.er-api.com serves, names and aliases, symbols, and a starter list of crypto
// currencies on Coinbase (the live list from Coinbase extends it once it has been fetched).

export const FIAT_CODES = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLF CLP CNH CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP FOK GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR KID KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TVD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF YER ZAR ZMW ZWG ZWL`.split(" "),
);

// Codes that are also everyday English words or names: they count only when the grammar is unambiguous
// (a number before them AND "to"/"in"/"into", or a "convert" pattern).
export const WORDLIKE_FIAT = new Set(["ALL", "TRY", "COP", "CUP", "GEL", "MAD", "MOP", "PEN", "RUB", "SOS", "TOP", "KID", "BOB", "RON", "ANG", "FOK", "MUR", "ARS", "LAK", "ERN", "SAR", "SEK", "TND", "NAD"]);

// Names that mean a currency but are also ordinary words ("won", "real", "pound", "lei", "sol"...).
export const WORDLIKE_NAMES = new Set(["won", "real", "pound", "lei", "leu", "rand", "lira", "mark", "kip", "lek", "dram", "som", "kiwi", "aussie", "colon", "dong", "kina", "tala", "pula", "dobra", "loti", "lari", "manat", "leone", "denar", "lev", "birr", "kyat", "riel", "tenge", "piso", "convertible mark"]);

// "dollar" is resolved with the dollarMeans setting.
export const DOLLAR = "$";

const entries = (code, ...names) => names.map((name) => [name, code]);

const BASE_FIAT_NAMES = [
  ...entries(DOLLAR, "dollar", "buck", "greenback"),
  ...entries("USD", "us dollar", "u.s. dollar", "american dollar", "united states dollar", "usa dollar"),
  ...entries("EUR", "euro"),
  ...entries("GBP", "pound sterling", "pounds sterling", "british pound", "uk pound", "english pound", "sterling", "quid", "pound", "gb pound"),
  ...entries("JPY", "yen", "japanese yen"),
  ...entries("CNY", "yuan", "renminbi", "rmb", "chinese yuan", "chinese renminbi"),
  ...entries("INR", "rupee", "indian rupee"),
  ...entries("PKR", "pakistani rupee"),
  ...entries("LKR", "sri lankan rupee"),
  ...entries("NPR", "nepalese rupee", "nepali rupee"),
  ...entries("CHF", "franc", "swiss franc"),
  ...entries("XOF", "cfa franc", "west african cfa franc"),
  ...entries("XAF", "central african cfa franc"),
  ...entries("XPF", "cfp franc"),
  ...entries("MXN", "peso", "mexican peso"),
  ...entries("ARS", "argentine peso", "argentinian peso"),
  ...entries("CLP", "chilean peso"),
  ...entries("COP", "colombian peso"),
  ...entries("PHP", "philippine peso", "philippines peso", "filipino peso"),
  ...entries("CUP", "cuban peso"),
  ...entries("UYU", "uruguayan peso"),
  ...entries("DOP", "dominican peso"),
  ...entries("KRW", "won", "korean won", "south korean won"),
  ...entries("BRL", "real", "brazilian real", "reais"),
  ...entries("SEK", "krona", "swedish krona", "kronor"),
  ...entries("NOK", "norwegian krone", "norwegian kroner"),
  ...entries("DKK", "krone", "danish krone", "danish kroner"),
  ...entries("ISK", "icelandic krona"),
  ...entries("CZK", "koruna", "czech koruna"),
  ...entries("RUB", "ruble", "rouble", "russian ruble", "russian rouble"),
  ...entries("BYN", "belarusian ruble"),
  ...entries("TRY", "lira", "turkish lira"),
  ...entries("ZAR", "rand", "south african rand"),
  ...entries("AED", "dirham", "uae dirham", "emirati dirham"),
  ...entries("MAD", "moroccan dirham"),
  ...entries("ILS", "shekel", "sheqel", "new shekel", "israeli shekel", "israeli new shekel"),
  ...entries("PLN", "zloty", "złoty", "polish zloty"),
  ...entries("HUF", "forint", "hungarian forint"),
  ...entries("THB", "baht", "thai baht"),
  ...entries("MYR", "ringgit", "malaysian ringgit"),
  ...entries("IDR", "rupiah", "indonesian rupiah"),
  ...entries("VND", "dong", "vietnamese dong"),
  ...entries("SAR", "riyal", "saudi riyal"),
  ...entries("QAR", "qatari riyal"),
  ...entries("OMR", "omani rial"),
  ...entries("IRR", "iranian rial"),
  ...entries("YER", "yemeni rial"),
  ...entries("KWD", "kuwaiti dinar"),
  ...entries("BHD", "bahraini dinar"),
  ...entries("IQD", "iraqi dinar"),
  ...entries("JOD", "jordanian dinar"),
  ...entries("DZD", "algerian dinar"),
  ...entries("LYD", "libyan dinar"),
  ...entries("TND", "tunisian dinar"),
  ...entries("RSD", "serbian dinar"),
  ...entries("NGN", "naira", "nigerian naira"),
  ...entries("GHS", "cedi", "ghanaian cedi"),
  ...entries("KES", "kenyan shilling"),
  ...entries("TZS", "tanzanian shilling"),
  ...entries("UGX", "ugandan shilling"),
  ...entries("EGP", "egyptian pound"),
  ...entries("LBP", "lebanese pound"),
  ...entries("SYP", "syrian pound"),
  ...entries("SDG", "sudanese pound"),
  ...entries("UAH", "hryvnia", "ukrainian hryvnia", "hryvnya"),
  ...entries("RON", "leu", "lei", "romanian leu"),
  ...entries("BGN", "lev", "leva", "bulgarian lev"),
  ...entries("HRK", "kuna", "croatian kuna"),
  ...entries("BDT", "taka", "bangladeshi taka"),
  ...entries("ETB", "birr", "ethiopian birr"),
  ...entries("AMD", "dram", "armenian dram"),
  ...entries("GEL", "lari", "georgian lari"),
  ...entries("KZT", "tenge", "kazakhstani tenge"),
  ...entries("AFN", "afghani"),
  ...entries("LAK", "kip", "lao kip"),
  ...entries("MMK", "kyat"),
  ...entries("KHR", "riel"),
  ...entries("MOP", "pataca"),
  ...entries("MNT", "tugrik", "togrog"),
  ...entries("BWP", "pula"),
  ...entries("MZN", "metical"),
  ...entries("AOA", "kwanza"),
  ...entries("PYG", "guarani"),
  ...entries("BOB", "boliviano"),
  ...entries("PEN", "peruvian sol", "nuevo sol"),
  ...entries("VES", "bolivar"),
  ...entries("GTQ", "quetzal"),
  ...entries("HNL", "lempira"),
  ...entries("NIO", "cordoba"),
  ...entries("CRC", "colon"),
  ...entries("PAB", "balboa"),
  ...entries("HTG", "gourde"),
  ...entries("CAD", "canadian dollar", "loonie"),
  ...entries("AUD", "australian dollar", "aussie dollar", "aussie"),
  ...entries("NZD", "new zealand dollar", "nz dollar", "kiwi dollar", "kiwi"),
  ...entries("HKD", "hong kong dollar", "hk dollar"),
  ...entries("SGD", "singapore dollar", "singaporean dollar"),
  ...entries("TWD", "taiwan dollar", "new taiwan dollar", "taiwanese dollar"),
  ...entries("XCD", "east caribbean dollar"),
  ...entries("NAD", "namibian dollar"),
  ...entries("FJD", "fijian dollar", "fiji dollar"),
  ...entries("TTD", "trinidad and tobago dollar"),
  ...entries("JMD", "jamaican dollar"),
  ...entries("BSD", "bahamian dollar"),
  ...entries("BND", "brunei dollar"),
  ...entries("LRD", "liberian dollar"),
];

// The base table wins over the extra aliases when a name appears in both.
export const FIAT_NAMES = new Map([...Object.entries(FIAT_ALIASES).flatMap(([code, names]) => entries(code, ...names)), ...BASE_FIAT_NAMES]);

// Plural forms that are not simply "+s"
export const IRREGULAR_PLURALS = new Map([["reais", "real"], ["kronor", "krona"], ["kroner", "krone"], ["lire", "lira"], ["leva", "lev"], ["lei", "leu"], ["pounds sterling", "pound sterling"], ["brazilian reais", "brazilian real"], ["soles", "sol"], ["rubles", "ruble"], ["leones", "leone"], ["lire", "lira"]]);

// Currency symbols. "$" follows the dollarMeans setting; "¥" is the yen (the yuan uses the same sign).
export const SYMBOLS = new Map([
  ["us$", "USD"], ["c$", "CAD"], ["ca$", "CAD"], ["a$", "AUD"], ["au$", "AUD"], ["nz$", "NZD"], ["hk$", "HKD"], ["s$", "SGD"], ["r$", "BRL"], ["mx$", "MXN"],
  ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₹", "INR"], ["₩", "KRW"], ["₽", "RUB"], ["₺", "TRY"], ["₪", "ILS"], ["₫", "VND"], ["₴", "UAH"],
  ["₦", "NGN"], ["₱", "PHP"], ["฿", "THB"], ["zł", "PLN"], ["₿", "BTC"], ["$", DOLLAR],
]);

export const DOLLAR_CHOICES = ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "MXN"];

// Crypto currencies that are always known (Coinbase lists more; they are added when the live list has been fetched).
export const STARTER_CRYPTO = new Map(
  Object.entries({
    BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", DOGE: "Dogecoin", XRP: "XRP", LTC: "Litecoin", ADA: "Cardano", USDC: "USD Coin", USDT: "Tether",
    BCH: "Bitcoin Cash", XLM: "Stellar", AVAX: "Avalanche", POL: "Polygon", MATIC: "Polygon", DOT: "Polkadot", LINK: "Chainlink", SHIB: "Shiba Inu",
    UNI: "Uniswap", ATOM: "Cosmos", ETC: "Ethereum Classic", DAI: "Dai", TRX: "Tron", AAVE: "Aave", ALGO: "Algorand", FIL: "Filecoin", NEAR: "NEAR Protocol",
    APT: "Aptos", ARB: "Arbitrum", OP: "Optimism", SUI: "Sui", HBAR: "Hedera", ICP: "Internet Computer", XTZ: "Tezos", EOS: "EOS", ZEC: "Zcash", PEPE: "Pepe",
  }),
);

const BASE_CRYPTO_NAMES = [
  ["bitcoin", "BTC"], ["ethereum", "ETH"], ["ether", "ETH"], ["solana", "SOL"], ["dogecoin", "DOGE"], ["ripple", "XRP"], ["litecoin", "LTC"],
  ["cardano", "ADA"], ["tether", "USDT"], ["usd coin", "USDC"], ["bitcoin cash", "BCH"], ["stellar", "XLM"], ["stellar lumens", "XLM"], ["avalanche", "AVAX"],
  ["polygon", "POL"], ["polkadot", "DOT"], ["chainlink", "LINK"], ["shiba inu", "SHIB"], ["uniswap", "UNI"], ["cosmos", "ATOM"], ["ethereum classic", "ETC"],
  ["tron", "TRX"], ["algorand", "ALGO"], ["filecoin", "FIL"], ["aptos", "APT"], ["arbitrum", "ARB"], ["hedera", "HBAR"], ["zcash", "ZEC"], ["tezos", "XTZ"],
];
export const CRYPTO_NAMES = new Map([...Object.entries(CRYPTO_ALIASES).flatMap(([code, names]) => entries(code, ...names)), ...BASE_CRYPTO_NAMES]);

// Crypto codes that may be used on their own ("btc") or after "price of".
export const BARE_CRYPTO = new Set(["BTC", "ETH", "XRP", "DOGE", "LTC"]);

// Crypto codes that are ordinary English words or names: they count only in an unambiguous "<number> <code> to <currency>" form.
export const WORDLIKE_CRYPTO = new Set(["ONE", "LINK", "NEAR", "DOT", "SAND", "APE", "OP", "MASK", "ROSE", "FLOW", "GAS", "FUN", "HOT", "CAKE", "JOY", "RUNE", "TIME", "POWER", "SUPER", "GAL", "UNI", "POL", "ATOM", "BAT", "COMP", "EOS", "SUI", "ARB", "APT", "ENS", "FIL", "ICP", "TRX"]);

const NAMES = {
  USD: "US dollar", EUR: "Euro", GBP: "British pound", JPY: "Japanese yen", CNY: "Chinese yuan", INR: "Indian rupee", CAD: "Canadian dollar", AUD: "Australian dollar",
  CHF: "Swiss franc", MXN: "Mexican peso", BRL: "Brazilian real", KRW: "South Korean won", SEK: "Swedish krona", NOK: "Norwegian krone", DKK: "Danish krone",
  NZD: "New Zealand dollar", SGD: "Singapore dollar", HKD: "Hong Kong dollar", PLN: "Polish zloty", CZK: "Czech koruna", HUF: "Hungarian forint", TRY: "Turkish lira",
  ZAR: "South African rand", RUB: "Russian ruble", ILS: "Israeli shekel", AED: "UAE dirham", SAR: "Saudi riyal", THB: "Thai baht",
};
export const currencyName = (code) => NAMES[code] ?? STARTER_CRYPTO.get(code) ?? code;
