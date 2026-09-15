const { poolPromise } = require('../../database/connection');

const getMachines = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT 
          'LDS' AS [Book],

          T0.[ItemCode] AS [Code], 

          T2.[Descr] AS [Type],

          T0.[ItemName] AS [Description],

          T3.[Location] AS [Location],

          (
              SELECT TOP 1 CAST(UsefulLife AS INT)
              FROM LDS_LIVE.dbo.ITM7
              WHERE ItemCode = T0.ItemCode
                AND DprArea = 'Main Area'
              ORDER BY PeriodCat DESC
          ) AS [Useful Life (M)],

          (
              SELECT TOP 1 CAST(RemainLife AS INT)
              FROM LDS_LIVE.dbo.ITM7
              WHERE ItemCode = T0.ItemCode
                AND DprArea = 'Main Area'
              ORDER BY PeriodCat DESC
          ) AS [Remaining Life (M)],

          (
              SELECT TOP 1 APC
              FROM LDS_LIVE.dbo.ITM8
              WHERE ItemCode = T0.ItemCode
                AND DprArea = 'Main Area'
              ORDER BY OrDpAcc DESC
          ) AS [APC],

          (
              SELECT SUM([OrdDprAmt])
              FROM LDS_LIVE.dbo.DRN2
              WHERE [ItemCode] = T0.ItemCode
          ) AS [Dep],

          (
              SELECT TOP 1 APC
              FROM LDS_LIVE.dbo.ITM8
              WHERE ItemCode = T0.ItemCode
                AND DprArea = 'Main Area'
              ORDER BY OrDpAcc DESC
          )
          -
          (
              SELECT SUM([OrdDprAmt])
              FROM LDS_LIVE.dbo.DRN2
              WHERE [ItemCode] = T0.ItemCode
          ) AS [FBV]

      FROM LDS_LIVE.dbo.OITM T0

      INNER JOIN LDS_LIVE.dbo.OACS T1
          ON T0.AssetClass = T1.Code

      INNER JOIN LDS_LIVE.dbo.OAGS T2
          ON T0.AssetGroup = T2.Code

      LEFT JOIN LDS_LIVE.dbo.OLCT T3
          ON T0.Location = T3.Code

      WHERE 
          T0.ItemCode LIKE 'L%'
          AND T3.[Location] = 'Production';
    `;
    const result = await pool.request().query(query);
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error fetching machines data:", error);
    res.status(500).json({ success: false, message: "Failed to fetch machine data" });
  }
};

module.exports = {
  getMachines
};
