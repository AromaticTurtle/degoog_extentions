// Word lists for the stock triggers. Kept in one file so they can be read, tested and adjusted in one place.

const set = (text) => new Set(text.trim().split(/\s+/));

// Bare queries that are NOT looked up as tickers, even in capitals: everyday words that are also tickers or likely searches, plus
// abbreviations, ISO currency codes and crypto symbols. `$A`, `$ALL`, `$NOW`... bypass this list (the dollar sign says "ticker").
export const BARE_STOPLIST = set(`
  A I AN AS AT BE BY DO GO HE IF IN IS IT ME MY NO OF OH ON OR SO TO UP US WE
  ALL AND ARE BUT CAN DAY FOR GET HAS HER HIM HIS HOW ITS LET MAY NEW NOT NOW OLD ONE OUR OUT SEE SHE THE TOO TWO USE WAS WAY WHO WHY YES YOU
  ABOUT AFTER AGAIN BEING BEST BIG COLD DOES DONE EACH EASY EVEN EVER FAST FIRST FOUND FREE FROM FUN GOOD GREAT HARD HAVE HELP HERE HOME HOT INTO JUST KEEP KNOW LAST LIFE LIKE LIVE LONG LOOK LOVE LOW MADE MAKE MANY MORE MOST MUCH MUST NEXT ONLY OPEN OVER PART PEAK PLAN PLAY POST REAL SAFE SAID SAME SAVE SEND SHOP SHOW SIGN SITE SOME SUCH TAKE TEAM TEXT THAN THAT THEM THEN THEY THIS TIME TOOL TRUE TRIP TRY VIEW WANT WELL WERE WHAT WHEN WILL WITH WORK YEAR YOUR ZONE
  CAT DOG CAR BOX BED BAG BAR BUS CUP EAR EYE FAN FOX HAT KEY LAB MAP MOM DAD PAN PEN PET RUN SUN TOP TOY VAN WIN ZOO
  AI PC TV UK EU UN NY LA SF DC USA CIA FBI IRS NASA NFL NBA MLB NHL UFC WWE CPU GPU RAM SSD HDD USB URL API CSS HTML PDF JPG PNG GIF DNS VPN SQL PHP SSH FTP TCP UDP LAN WAN IP OS HR PR CEO CFO COO CTO ETF IPO ATM GDP CPI
  USD EUR GBP JPY CAD AUD CHF CNY INR MXN BRL KRW SEK NOK DKK NZD SGD HKD PLN CZK HUF TRY ZAR RUB ILS AED SAR THB
  BTC ETH XRP DOGE LTC ADA SOL USDT USDC BCH XLM DOT LINK SHIB UNI ATOM ETC DAI TRX
  STOCK PRICE QUOTE SHARE NEWS GAMES MAIL WIKI JOBS DEALS SALE VIDEO MUSIC PHOTO CHAT
`);

// Well-known tickers: a bare lowercase or mixed-case query ("aapl", "Tsla") is only looked up for these. Two letters or fewer still
// need capitals ("V", "MA", "KO"). Must not overlap BARE_STOPLIST (a test checks).
export const WELL_KNOWN = set(`
  AAPL MSFT GOOG GOOGL AMZN TSLA META NVDA NFLX AMD INTC IBM DIS KO PEP WMT JPM BAC V MA PYPL UBER ABNB ORCL CRM ADBE CSCO QCOM AVGO TXN MU SQ COIN PLTR SNAP PINS SPOT
  BA GE GM F T VZ XOM CVX PFE MRK JNJ UNH ABBV LLY COST HD TGT NKE MCD SBUX CMG BRK.A BRK.B WFC GS MS C AXP SCHW BLK
  SPY QQQ VOO VTI IWM DIA ARKK
`);

// Words that mean the query is not about a stock when they sit next to the word "stock" ("chicken stock", "stock photo"...)
export const NOT_FINANCIAL = set(`
  pot pots photo photos picture pictures image images footage video videos car cars racing room rooms broth cube cubes cubes up still response take taking holder exchange market markets
  chicken beef vegetable vegetables veg fish bone bones pork turkey lamb duck ham mushroom seafood shrimp homemade sodium soup sauce recipe recipes cooking kitchen
  option options trading trader traders analysis chart charts screener screeners symbol symbols ticker tickers footage music sound sounds art vector vectors icon icons
  illustration illustrations template templates
`);

// A stock query whose first word is one of these is a question or a concept, not a company: "define stock", "penny stock", "best stock".
export const REJECT_FIRST = set(`
  define definition meaning what whats how why when where which who is are was be do does can could should would will the a an this that these those to of in on at for and or
  my your our their its penny blue growth value dividend meme tech technology buy sell buying selling good best top cheap hot new old free live real current latest
  preferred common restricted treasury out price prices quote quotes api symbol symbols today now news chart charts history forecast prediction
`);
