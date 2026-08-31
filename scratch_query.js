require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');

async function runQueries() {
  try {
    const pool = await poolPromise;

    // 1. Dashboard Query (All Shortages)
    const dashboardQuery = `
      SELECT TOP 10
          m.ItemCode,
          m.ItemName,
          ISNULL(SUM(w.IsCommited), 0) as RequiredQty,
          ISNULL(SUM(w.OnHand), 0) as AvailableQty,
          ISNULL(SUM(w.IsCommited), 0) - ISNULL(SUM(w.OnHand), 0) as Shortage
      FROM LDS_LIVE.dbo.OITW w
      INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode
      GROUP BY m.ItemCode, m.ItemName
      HAVING SUM(w.OnHand) < SUM(w.IsCommited)
      ORDER BY Shortage DESC
    `;
    const dashRes = await pool.request().query(dashboardQuery);

    // 2. Old Production Planning Query
    const oldProdQuery = `
      WITH ComponentDemand AS (
          SELECT 
              w.ItemCode AS ComponentCode,
              SUM(w.PlannedQty - w.IssuedQty) AS RemainingRequired
          FROM LDS_Live.dbo.WOR1 w (NOLOCK)
          INNER JOIN LDS_Live.dbo.OWOR p (NOLOCK) ON w.DocEntry = p.DocEntry
          WHERE p.Status = 'R' AND w.ItemType = 4 AND (w.PlannedQty - w.IssuedQty) > 0
          GROUP BY w.ItemCode
      ),
      AvailableStock AS (
          SELECT 
              ItemCode, 
              SUM(OnHand) AS TotalAvailable
          FROM LDS_Live.dbo.OITW (NOLOCK)
          GROUP BY ItemCode
      ),
      Shortages AS (
          SELECT TOP 10
              d.ComponentCode,
              i.ItemName AS ComponentName,
              d.RemainingRequired,
              ISNULL(s.TotalAvailable, 0) AS TotalAvailable,
              CASE 
                  WHEN ISNULL(s.TotalAvailable, 0) < d.RemainingRequired 
                  THEN d.RemainingRequired - ISNULL(s.TotalAvailable, 0) 
                  ELSE 0 
              END AS ShortageQty
          FROM ComponentDemand d
          LEFT JOIN AvailableStock s ON d.ComponentCode = s.ItemCode
          LEFT JOIN LDS_Live.dbo.OITM i (NOLOCK) ON d.ComponentCode = i.ItemCode
          WHERE ISNULL(s.TotalAvailable, 0) < d.RemainingRequired
          ORDER BY ShortageQty DESC
      )
      SELECT * FROM Shortages 
    `;
    const oldProdRes = await pool.request().query(oldProdQuery);

    // 3. New Production Planning Query
    const newProdQuery = `
      WITH ProdComponents AS (
          SELECT DISTINCT w1.ItemCode
          FROM LDS_LIVE.dbo.WOR1 w1 (NOLOCK)
          INNER JOIN LDS_LIVE.dbo.OWOR p (NOLOCK) ON w1.DocEntry = p.DocEntry 
          WHERE p.Status = 'R' AND w1.ItemType = 4 AND (w1.PlannedQty - w1.IssuedQty) > 0
      ),
      Shortages AS (
          SELECT TOP 10
              m.ItemCode AS ComponentCode,
              m.ItemName AS ComponentName,
              ISNULL(SUM(w.IsCommited), 0) AS RemainingRequired,
              ISNULL(SUM(w.OnHand), 0) AS TotalAvailable,
              ISNULL(SUM(w.IsCommited), 0) - ISNULL(SUM(w.OnHand), 0) AS ShortageQty
          FROM LDS_LIVE.dbo.OITW w (NOLOCK)
          INNER JOIN LDS_LIVE.dbo.OITM m (NOLOCK) ON w.ItemCode = m.ItemCode
          INNER JOIN ProdComponents pc ON m.ItemCode = pc.ItemCode
          GROUP BY m.ItemCode, m.ItemName
          HAVING SUM(w.OnHand) < SUM(w.IsCommited)
          ORDER BY ShortageQty DESC
      )
      SELECT * FROM Shortages 
    `;
    const newProdRes = await pool.request().query(newProdQuery);

    console.log(JSON.stringify({ 
        dashboard: dashRes.recordset, 
        oldProd: oldProdRes.recordset,
        newProd: newProdRes.recordset
    }));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
runQueries();
