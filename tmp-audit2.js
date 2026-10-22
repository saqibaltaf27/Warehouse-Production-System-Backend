require('dotenv').config();
const { poolPromise } = require('./src/database/connection');

const queries = {
  // 1. Executive live snapshot
  exec: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT
      COUNT(*) AS OpenOrders,
      SUM(ISNULL(PlannedQty,0)) AS OpenPlannedQty,
      SUM(ISNULL(CmpltQty,0)) AS OpenCompletedQty,
      SUM(CASE WHEN ISNULL(PlannedQty,0)>ISNULL(CmpltQty,0) THEN ISNULL(PlannedQty,0)-ISNULL(CmpltQty,0) ELSE 0 END) AS OpenRemainingQty,
      SUM(CASE WHEN DueDate<@t THEN 1 ELSE 0 END) AS Overdue,
      SUM(CASE WHEN DueDate=@t THEN 1 ELSE 0 END) AS DueToday,
      SUM(CASE WHEN DueDate>@t AND DueDate<=DATEADD(DAY,7,@t) THEN 1 ELSE 0 END) AS DueThisWeek,
      SUM(CASE WHEN ISNULL(CmpltQty,0)>0 AND ISNULL(CmpltQty,0)<ISNULL(PlannedQty,0) THEN 1 ELSE 0 END) AS PartiallyCompleted,
      MAX(DATEDIFF(DAY, StartDate, @t)) AS OldestOpenAgeDays
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE Status IN ('P','R')`,

  // 2. Overdue detail with material-shortage blocker flag
  overdue: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT TOP 15
      O.DocNum, O.ItemCode, O.ProdName, O.Warehouse,
      O.PlannedQty, O.CmpltQty,
      O.PlannedQty-O.CmpltQty AS RemainingQty,
      O.StartDate, O.DueDate,
      DATEDIFF(DAY,O.DueDate,@t) AS DaysOverdue,
      O.Status,
      ISNULL(M.ShortItems,0) AS ShortItems
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    OUTER APPLY (
      SELECT COUNT(*) AS ShortItems FROM (
        SELECT L.ItemCode
        FROM LDS_LIVE.dbo.WOR1 L WITH (NOLOCK)
        LEFT JOIN LDS_LIVE.dbo.OITW W WITH (NOLOCK) ON L.ItemCode=W.ItemCode AND L.wareHouse=W.WhsCode
        WHERE L.DocEntry=O.DocEntry
        GROUP BY L.ItemCode
        HAVING SUM(ISNULL(L.PlannedQty,0))-SUM(ISNULL(L.IssuedQty,0)) > SUM(ISNULL(W.OnHand,0))
      ) x
    ) M
    WHERE O.Status IN ('P','R') AND O.DueDate<@t AND ISNULL(O.CmpltQty,0)<ISNULL(O.PlannedQty,0)
    ORDER BY DaysOverdue DESC`,

  // 3. Material shortage rollup
  shortageRollup: `
    SELECT
      COUNT(DISTINCT DocEntry) AS BlockedOrders,
      COUNT(*) AS ShortLines
    FROM (
      SELECT L.DocEntry, L.ItemCode
      FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
      JOIN LDS_LIVE.dbo.WOR1 L WITH (NOLOCK) ON O.DocEntry=L.DocEntry
      LEFT JOIN LDS_LIVE.dbo.OITW W WITH (NOLOCK) ON L.ItemCode=W.ItemCode AND L.wareHouse=W.WhsCode
      WHERE O.Status IN ('P','R')
      GROUP BY L.DocEntry, L.ItemCode
      HAVING SUM(ISNULL(L.PlannedQty,0))-SUM(ISNULL(L.IssuedQty,0)) > SUM(ISNULL(W.OnHand,0))
    ) s`,

  shortageDetail: `
    SELECT TOP 12
      L.ItemCode, MAX(I.ItemName) AS ItemName, L.wareHouse,
      SUM(ISNULL(L.PlannedQty,0)) AS RequiredQty,
      SUM(ISNULL(L.IssuedQty,0)) AS IssuedQty,
      SUM(ISNULL(L.PlannedQty,0))-SUM(ISNULL(L.IssuedQty,0)) AS OpenRequirement,
      MAX(ISNULL(W.OnHand,0)) AS OnHand,
      MAX(ISNULL(W.IsCommited,0)) AS Committed,
      MAX(ISNULL(W.OnOrder,0)) AS OnOrder,
      COUNT(DISTINCT L.DocEntry) AS AffectedOrders
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    JOIN LDS_LIVE.dbo.WOR1 L WITH (NOLOCK) ON O.DocEntry=L.DocEntry
    LEFT JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON L.ItemCode=I.ItemCode
    LEFT JOIN LDS_LIVE.dbo.OITW W WITH (NOLOCK) ON L.ItemCode=W.ItemCode AND L.wareHouse=W.WhsCode
    WHERE O.Status IN ('P','R')
    GROUP BY L.ItemCode, L.wareHouse
    HAVING SUM(ISNULL(L.PlannedQty,0))-SUM(ISNULL(L.IssuedQty,0)) > MAX(ISNULL(W.OnHand,0))
    ORDER BY OpenRequirement DESC`,

  // 4. WIP aging buckets
  wipAging: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT
      CASE
        WHEN DATEDIFF(DAY,StartDate,@t) <= 7 THEN '0-7 days'
        WHEN DATEDIFF(DAY,StartDate,@t) <= 30 THEN '8-30 days'
        WHEN DATEDIFF(DAY,StartDate,@t) <= 90 THEN '31-90 days'
        ELSE 'over 90 days'
      END AS AgeBucket,
      COUNT(*) AS Orders,
      SUM(CASE WHEN ISNULL(PlannedQty,0)>ISNULL(CmpltQty,0) THEN ISNULL(PlannedQty,0)-ISNULL(CmpltQty,0) ELSE 0 END) AS RemainingQty
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE Status IN ('P','R')
    GROUP BY CASE
        WHEN DATEDIFF(DAY,StartDate,@t) <= 7 THEN '0-7 days'
        WHEN DATEDIFF(DAY,StartDate,@t) <= 30 THEN '8-30 days'
        WHEN DATEDIFF(DAY,StartDate,@t) <= 90 THEN '31-90 days'
        ELSE 'over 90 days'
      END`,

  // 5. Material issued to open orders (IGE via OWOR link)
  issuedToOpen: `
    SELECT COUNT(*) AS IssueLines, SUM(ISNULL(L.Quantity,0)) AS IssuedQty
    FROM LDS_LIVE.dbo.IGE1 L WITH (NOLOCK)
    JOIN LDS_LIVE.dbo.OWOR O WITH (NOLOCK) ON L.BaseEntry=O.DocEntry AND L.BaseType=202
    WHERE O.Status IN ('P','R')`,

  // 6. Consumption variance planned vs actual issued
  consumption: `
    SELECT TOP 8
      L.ItemCode, MAX(I.ItemName) AS ItemName,
      SUM(ISNULL(L.PlannedQty,0)) AS PlannedQty,
      SUM(ISNULL(L.IssuedQty,0)) AS IssuedQty,
      SUM(ISNULL(L.IssuedQty,0))-SUM(ISNULL(L.PlannedQty,0)) AS Variance
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    JOIN LDS_LIVE.dbo.WOR1 L WITH (NOLOCK) ON O.DocEntry=L.DocEntry
    LEFT JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON L.ItemCode=I.ItemCode
    WHERE O.Status='L' AND O.CloseDate>=DATEADD(MONTH,-1,CAST(GETDATE() AS DATE))
    GROUP BY L.ItemCode
    ORDER BY ABS(SUM(ISNULL(L.IssuedQty,0))-SUM(ISNULL(L.PlannedQty,0))) DESC`,

  // 7. QC: sample link to production receipts + inspection aging
  qcLink: `
    SELECT a.U_Type, COUNT(*) AS Docs FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK) GROUP BY a.U_Type`,

  qcAging: `
    DECLARE @t DATE = CAST(GETDATE() AS DATE);
    SELECT
      DATEDIFF(DAY, a.U_SmpDate, @t) AS AgeDays,
      COUNT(*) AS Lines
    FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
    JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry=b.DocEntry
    WHERE b.U_Status IN ('S','UI')
    GROUP BY DATEDIFF(DAY, a.U_SmpDate, @t)
    ORDER BY AgeDays DESC`,

  // 8. Resource linkage check
  worResource: `
    SELECT TOP 3 * FROM LDS_LIVE.dbo.WOR1 WITH (NOLOCK) WHERE ItemType=4`,

  resourceCols: `
    SELECT COLUMN_NAME FROM LDS_LIVE.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ORSC'
      AND (COLUMN_NAME LIKE '%Cap%' OR COLUMN_NAME LIKE '%Time%' OR COLUMN_NAME IN ('ResCode','ResName','ResType','Active'))`,

  itemTypeMix: `
    SELECT ItemType, COUNT(*) AS Lines FROM LDS_LIVE.dbo.WOR1 WITH (NOLOCK) GROUP BY ItemType`,

  issueTypeMix: `
    SELECT IssueType, COUNT(*) AS Lines FROM LDS_LIVE.dbo.WOR1 WITH (NOLOCK) GROUP BY IssueType`,

  // 9. Warehouses used on production orders
  whs: `
    SELECT O.Warehouse, W.WhsName, COUNT(*) AS Orders
    FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
    LEFT JOIN LDS_LIVE.dbo.OWHS W WITH (NOLOCK) ON O.Warehouse=W.WhsCode
    GROUP BY O.Warehouse, W.WhsName ORDER BY Orders DESC`,

  // 10. Lead time (start -> close) for closed orders
  leadTime: `
    SELECT
      COUNT(*) AS ClosedOrders,
      AVG(CAST(DATEDIFF(DAY,StartDate,CloseDate) AS FLOAT)) AS AvgDays,
      MIN(DATEDIFF(DAY,StartDate,CloseDate)) AS MinDays,
      MAX(DATEDIFF(DAY,StartDate,CloseDate)) AS MaxDays
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE Status='L' AND CloseDate IS NOT NULL AND CloseDate>=StartDate`,

  // 11. On-time trend last 6 months
  onTimeTrend: `
    DECLARE @s DATE = DATEADD(MONTH,-5,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1));
    SELECT YEAR(DueDate) AS Y, MONTH(DueDate) AS M,
      COUNT(*) AS DueOrders,
      SUM(CASE WHEN Status='L' THEN 1 ELSE 0 END) AS ClosedOrders,
      SUM(CASE WHEN Status='L' AND CloseDate<=DueDate THEN 1 ELSE 0 END) AS OnTimeOrders,
      SUM(ISNULL(PlannedQty,0)) AS PlannedQty,
      SUM(ISNULL(CmpltQty,0)) AS CmpltQty
    FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
    WHERE DueDate>=@s AND Status<>'C'
    GROUP BY YEAR(DueDate),MONTH(DueDate) ORDER BY Y,M`,
};

(async () => {
  const pool = await poolPromise;
  const out = {};
  for (const [name, q] of Object.entries(queries)) {
    try {
      const r = await pool.request().query(q);
      out[name] = r.recordset;
    } catch (e) {
      out[name] = { ERROR: e.message };
    }
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
