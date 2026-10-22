require('dotenv').config();
const { poolPromise } = require('./src/database/connection');

const MONTH = 10;
const YEAR = 2026;

const queries = {
  statusLifetime: `
    SELECT Status, COUNT(*) AS Orders, SUM(ISNULL(PlannedQty,0)) AS PlannedQty, SUM(ISNULL(CmpltQty,0)) AS CmpltQty, SUM(ISNULL(RjctQty,0)) AS RjctQty
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK) GROUP BY Status`,

  monthCohort: `
    DECLARE @s DATE = DATEFROMPARTS(${YEAR},${MONTH},1); DECLARE @e DATE = DATEADD(MONTH,1,@s);
    SELECT
      COUNT(*) AS DueInMonth,
      SUM(CASE WHEN Status='L' AND CloseDate>=@s AND CloseDate<@e THEN 1 ELSE 0 END) AS DueAndClosedInMonth,
      SUM(CASE WHEN Status='L' AND CloseDate<=DueDate THEN 1 ELSE 0 END) AS DueAndClosedOnTime,
      SUM(CASE WHEN Status='L' THEN 1 ELSE 0 END) AS DueAndClosedAnyTime,
      SUM(CASE WHEN Status='C' THEN 1 ELSE 0 END) AS DueAndCancelled,
      SUM(ISNULL(PlannedQty,0)) AS PlannedQty,
      SUM(ISNULL(CmpltQty,0)) AS CmpltQty,
      SUM(ISNULL(RjctQty,0)) AS RjctQty
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE DueDate>=@s AND DueDate<@e`,

  closedInMonthCohort: `
    DECLARE @s DATE = DATEFROMPARTS(${YEAR},${MONTH},1); DECLARE @e DATE = DATEADD(MONTH,1,@s);
    SELECT COUNT(*) AS ClosedInMonthAnyDue,
      SUM(CASE WHEN DueDate>=@s AND DueDate<@e THEN 1 ELSE 0 END) AS AlsoDueInMonth,
      SUM(CASE WHEN CloseDate<=DueDate THEN 1 ELSE 0 END) AS ClosedOnTime
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE Status='L' AND CloseDate>=@s AND CloseDate<@e`,

  liveOps: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT
      SUM(CASE WHEN Status IN ('P','R') AND DueDate<@t AND ISNULL(CmpltQty,0)<ISNULL(PlannedQty,0) THEN 1 ELSE 0 END) AS Overdue,
      SUM(CASE WHEN Status IN ('P','R') AND DueDate=@t THEN 1 ELSE 0 END) AS DueToday,
      SUM(CASE WHEN Status IN ('P','R') AND DueDate>@t AND DueDate<=DATEADD(DAY,7,@t) THEN 1 ELSE 0 END) AS DueNext7,
      SUM(CASE WHEN Status='R' AND ISNULL(CmpltQty,0)>0 AND ISNULL(CmpltQty,0)<ISNULL(PlannedQty,0) THEN 1 ELSE 0 END) AS PartiallyDone,
      SUM(CASE WHEN Status IN ('P','R') THEN ISNULL(PlannedQty,0)-ISNULL(CmpltQty,0) ELSE 0 END) AS OpenRemainingQty
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)`,

  oworCols: `
    SELECT COLUMN_NAME, DATA_TYPE FROM LDS_LIVE.INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='OWOR' AND (COLUMN_NAME LIKE '%Date%' OR COLUMN_NAME LIKE '%Qty%' OR COLUMN_NAME IN ('Status','Type','Warehouse','ItemCode','ProdName','DocNum','DocEntry','Project','Comments','PostDate'))
    ORDER BY COLUMN_NAME`,

  dateNulls: `
    SELECT COUNT(*) AS Total,
      SUM(CASE WHEN StartDate IS NULL THEN 1 ELSE 0 END) AS NullStart,
      SUM(CASE WHEN DueDate IS NULL THEN 1 ELSE 0 END) AS NullDue,
      SUM(CASE WHEN CloseDate IS NULL THEN 1 ELSE 0 END) AS NullClose,
      SUM(CASE WHEN PostDate IS NULL THEN 1 ELSE 0 END) AS NullPost,
      SUM(CASE WHEN Status='L' AND CloseDate IS NULL THEN 1 ELSE 0 END) AS ClosedNoCloseDate
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)`,

  wor1Cols: `
    SELECT COLUMN_NAME, DATA_TYPE FROM LDS_LIVE.INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='WOR1' AND (COLUMN_NAME LIKE '%Qty%' OR COLUMN_NAME IN ('DocEntry','LineNum','ItemCode','wareHouse','IssueType','ItemType','BaseQty','useBaseUn'))
    ORDER BY COLUMN_NAME`,

  materialShortage: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT TOP 10
      O.DocNum, L.ItemCode, L.wareHouse,
      SUM(ISNULL(L.PlannedQty,0)) AS Required,
      SUM(ISNULL(L.IssuedQty,0)) AS Issued,
      MAX(ISNULL(W.OnHand,0)) AS OnHand,
      MAX(ISNULL(W.IsCommited,0)) AS Committed,
      MAX(ISNULL(W.OnOrder,0)) AS OnOrder
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    JOIN LDS_LIVE.dbo.WOR1 L WITH (NOLOCK) ON O.DocEntry=L.DocEntry
    LEFT JOIN LDS_LIVE.dbo.OITW W WITH (NOLOCK) ON L.ItemCode=W.ItemCode AND L.wareHouse=W.WhsCode
    WHERE O.Status IN ('P','R')
    GROUP BY O.DocNum, L.ItemCode, L.wareHouse
    HAVING SUM(ISNULL(L.PlannedQty,0))-SUM(ISNULL(L.IssuedQty,0)) > MAX(ISNULL(W.OnHand,0))
    ORDER BY O.DocNum`,

  tableExists: `
    SELECT TABLE_NAME FROM LDS_LIVE.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME IN ('OWOR','WOR1','WOR2','WOR4','OITT','ITT1','OITM','OITW','OWHS','OIGE','IGE1','OIGN','IGN1','OITL','ORSC','ORCJ','RSC1','RSC4','OITB','OBTN','OBTQ','OBTW','OIBT')
    ORDER BY TABLE_NAME`,

  resourceUse: `
    SELECT COUNT(*) AS ResourceRows FROM LDS_LIVE.dbo.ORSC WITH (NOLOCK)`,

  batchUse: `
    SELECT COUNT(*) AS BatchRows FROM LDS_LIVE.dbo.OBTN WITH (NOLOCK)`,

  sampleMonth: `
    DECLARE @s DATE = DATEFROMPARTS(${YEAR},${MONTH},1); DECLARE @e DATE = DATEADD(MONTH,1,@s);
    SELECT b.U_status AS Code, COUNT(*) AS Lines, COUNT(DISTINCT a.DocEntry) AS Docs
    FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
    JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry=b.DocEntry
    WHERE a.U_SmpDate>=@s AND a.U_SmpDate<@e
    GROUP BY b.U_status`,

  smpCols: `
    SELECT COLUMN_NAME FROM DOME.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='@XD_SMP1' ORDER BY COLUMN_NAME`,

  osmpCols: `
    SELECT COLUMN_NAME FROM DOME.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='@XD_OSMP' ORDER BY COLUMN_NAME`,

  qcSummaryCheck: `
    DECLARE @s DATE = DATEFROMPARTS(${YEAR},${MONTH},1); DECLARE @e DATE = DATEADD(MONTH,1,@s);
    SELECT
      SUM(O.PlannedQty) AS PlannedQty,
      SUM(ISNULL(IGN.ProducedQty,0)) AS ReceiptQty,
      SUM(ISNULL(O.CmpltQty,0)) AS OworCmpltQty,
      COUNT(*) AS Orders
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    LEFT JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON O.ItemCode=I.ItemCode
    LEFT JOIN LDS_LIVE.dbo.OITB G WITH (NOLOCK) ON I.ItmsGrpCod=G.ItmsGrpCod
    LEFT JOIN (SELECT BaseEntry, SUM(Quantity) AS ProducedQty FROM LDS_LIVE.dbo.IGN1 WITH (NOLOCK) WHERE BaseType=202 GROUP BY BaseEntry) IGN ON O.DocEntry=IGN.BaseEntry
    WHERE O.PostDate>=@s AND O.PostDate<@e AND G.ItmsGrpNam LIKE 'FG%'`,
};

(async () => {
  const pool = await poolPromise;
  const out = {};
  for (const [name, q] of Object.entries(queries)) {
    try {
      const r = await pool.request().query(q);
      out[name] = r.recordsets.length > 1 ? r.recordsets : r.recordset;
    } catch (e) {
      out[name] = { ERROR: e.message };
    }
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
