const ETORO_TICKERS = new Set([
  'AAPL','MSFT','GOOGL','GOOG','AMZN','META','TSLA','NVDA','AMD','INTC',
  'NFLX','ADBE','CRM','ORCL','CSCO','AVGO','QCOM','TXN','IBM','SHOP',
  'SQ','SNAP','UBER','LYFT','PINS','TWLO','ZM','DOCU','OKTA','CRWD',
  'NET','DDOG','SNOW','PLTR','U','RBLX','COIN','HOOD','SOFI','AFRM',
  'MU','MRVL','ON','SMCI','ARM','DELL','HPQ','HPE','PANW','FTNT','ZS','CYBR',
  'JNJ','PFE','UNH','MRNA','ABBV','LLY','BMY','MRK','AMGN','GILD',
  'BIIB','REGN','VRTX','ISRG','MDT','ABT','TMO','DHR','SYK','BSX',
  'EW','ZBH','DXCM','HIMS','TDOC','NVAX',
  'JPM','BAC','WFC','GS','MS','C','AXP','V','MA','PYPL',
  'BLK','SCHW','CME','ICE','SPGI','MCO','TFC','USB','PNC','COF','DFS','SYF','ALLY',
  'WMT','COST','TGT','HD','LOW','NKE','SBUX','MCD','KO','PEP',
  'PG','CL','EL','LULU','TJX','ROST','DG','DLTR','ETSY','EBAY','W','CHWY',
  'DIS','CMCSA','PARA','WBD','SPOT','ROKU',
  'XOM','CVX','COP','EOG','SLB','OXY','MPC','VLO','PSX','HAL','DVN','FANG','HES','BKR',
  'BA','CAT','DE','HON','GE','MMM','LMT','RTX','NOC','GD',
  'UPS','FDX','UNP','CSX','NSC','WM','RSG','EMR','ETN','ITW',
  'RIVN','LCID','NIO','XPEV','LI','F','GM','TM',
  'AMT','PLD','CCI','EQIX','SPG','O','PSA','DLR','WELL','AVB',
  'T','VZ','TMUS','TLRY','CGC','ACB','CRON',
  'MSTR','MARA','RIOT','CLSK','HUT','AI','PATH','UPST','BBAI','SOUN',
  'RKLB','SPCE','ABNB','DASH','DKNG','PENN','MGM','BABA','TSM','ASML','SAP','NVO'
]);

const REVOLUT_TICKERS = new Set([
  ...ETORO_TICKERS,
  'ACHR','ANET','ANSS','APD','APH','APTV','ATO','AWK','AZO',
  'BALL','BAX','BDX','BEN','BIO','BR','BRO','BWA',
  'CARR','CB','CBOE','CBRE','CCL','CDNS','CDW','CE','CEG','CF','CHD','CHRW','CHTR','CI',
  'CINF','CLX','CMA','CMS','CNC','CNP','CPRT','CPT','CRL','CSGP','CTAS','CTRA','CTSH','CTVA','CVS','CZR',
  'DAL','DD','DGX','DPZ','DRI','DTE','DUK','DVA',
  'EA','ECL','ED','EFX','EIX','EMN','ENPH','EPAM','EQR','EQT','ES','ESS','ETR','EVRG','EXC','EXPD','EXPE','EXR',
  'FAST','FCX','FDS','FE','FFIV','FIS','FISV','FMC','FOX','FOXA','FRT','FSLR',
  'GEN','GL','GLW','GNRC','GPC','GPN','GRMN','GWW',
  'HAS','HBAN','HCA','HOLX','HST','HSY','HUBB','HWM',
  'IEX','IFF','ILMN','INCY','INTU','INVH','IP','IPG','IQV','IR','IRM',
  'J','JBHT','JCI','JKHY','JNPR',
  'K','KDP','KEY','KEYS','KHC','KIM','KLAC','KMB','KMI','KMX','KR',
  'L','LDOS','LEN','LH','LIN','LKQ','LNT','LRCX','LUV','LVS','LW','LYB','LYV',
  'MAA','MAR','MAS','MKC','MCHP','MDLZ','MKTX','MLM','MOH','MOS','MPWR','MSCI','MTB','MTCH','MTD',
  'NDAQ','NDSN','NEE','NEM','NI','NRG','NUE','NVR',
  'ODFL','OKE','OMC','ORLY','OTIS',
  'PAYC','PAYX','PCAR','PCG','PEG','PFG','PHM','PKG','POOL','PPG','PPL','PRU','PTC','PWR',
  'RCL','RE','REG','RF','RHI','RJF','RL','RMD','ROK','ROL','ROP',
  'SBAC','SEDG','SEE','SHW','SJM','SNA','SNPS','SO','SRE','STE','STLD','STT','STX','STZ','SWK','SWKS','SYY',
  'TAP','TDG','TDY','TECH','TEL','TER','TFX','TRGP','TRMB','TROW','TRV','TSCO','TSN','TT','TTWO','TYL',
  'UAL','ULTA','UDR','URI',
  'VICI','VMC','VRSK','VRSN','VTR','VTRS',
  'WAB','WAT','WBA','WDC','WEC','WHR','WMB','WRB','WRK','WST','WTW','WY','WYNN',
  'XEL','XRAY','XYL','YUM','ZBRA','ZION','ZTS'
]);

export function checkAvailability(symbol) {
  const upper = symbol.toUpperCase();
  return { etoro: ETORO_TICKERS.has(upper), revolut: REVOLUT_TICKERS.has(upper) };
}
