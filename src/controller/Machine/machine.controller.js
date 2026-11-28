const { sql, poolPromise } = require('../../database/connection');

const getMachines = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;
    const status = req.query.status === 'Active' || req.query.status === 'Inactive' ? req.query.status : '';
    const search = String(req.query.search || '').trim();
    const exportAll = req.query.all === '1';

    const pool = await poolPromise;
    const request = pool.request()
      .input('Offset', sql.Int, offset)
      .input('PageSize', sql.Int, pageSize)
      .input('Search', sql.NVarChar, `%${search}%`);

    const statusSql = status === 'Active'
      ? "AND T0.AsstStatus = 'A'"
      : status === 'Inactive'
        ? "AND T0.AsstStatus = 'I'"
        : "AND T0.AsstStatus IN ('A', 'I')";
    const searchSql = search
      ? `AND (
          T0.ItemCode LIKE @Search
          OR T0.ItemName LIKE @Search
          OR T0.AssetSerNo LIKE @Search
          OR T4.Location LIKE @Search
          OR T5.firstName LIKE @Search
        )`
      : '';

    const query = `
      SELECT
        CASE
          WHEN T0.[AsstStatus] = 'A' THEN 'Active'
          WHEN T0.[AsstStatus] = 'N' THEN 'New'
          WHEN T0.[AsstStatus] = 'I' THEN 'Inactive'
        END AS [Status],
        T0.[AcqDate] AS [Capitalized],
        CONCAT('FY-', CASE
          WHEN MONTH(T0.AcqDate) BETWEEN 7 AND 12 THEN CONCAT(YEAR(T0.AcqDate), '/', YEAR(T0.AcqDate) + 1)
          ELSE CONCAT(YEAR(T0.AcqDate) - 1, '/', YEAR(T0.AcqDate))
        END) AS FiscalYear,
        T2.[Name] AS [Class],
        T3.[Descr] AS [AssetGroup],
        T0.[ItemCode],
        UPPER(T0.[ItemName]) AS [Description],
        T0.[AssetSerNo] AS [SerialNo],
        T4.[Location] AS [Location],
        T0.[U_cat1] AS [Category],
        T0.[U_Division] AS [Division],
        T0.[U_Type] AS [Type],
        T0.[U_ProductLine] AS [ProductLine],
        T5.[firstName] AS [Staff],
        IIF(MAX(T6.APC) > 0, MAX(T6.APC), MAX(P1.LineTotal)) AS [APV],
        IIF(MAX(T6.OrDpAcc) > 0, MAX(T6.OrDpAcc), (
          SELECT SUM(OrdDprAmt) FROM LDS_LIVE.dbo.DRN2 WHERE ItemCode = T0.ItemCode
        )) AS [DPR],
        (
          IIF(MAX(T6.APC) > 0, MAX(T6.APC), MAX(P1.LineTotal))
          - IIF(MAX(T6.OrDpAcc) > 0, MAX(T6.OrDpAcc), (
            SELECT SUM(OrdDprAmt) FROM LDS_LIVE.dbo.DRN2 WHERE ItemCode = T0.ItemCode
          ))
        ) AS [FBV]
      FROM LDS_LIVE.dbo.OITM T0
      INNER JOIN LDS_LIVE.dbo.OITB T1 ON T0.ItmsGrpCod = T1.ItmsGrpCod AND T0.[AsstStatus] <> 'N'
      INNER JOIN LDS_LIVE.dbo.OACS T2 ON T0.AssetClass = T2.Code
      LEFT JOIN LDS_LIVE.dbo.OAGS T3 ON T0.AssetGroup = T3.Code
      LEFT JOIN LDS_LIVE.dbo.OLCT T4 ON T0.Location = T4.Code
      LEFT JOIN LDS_LIVE.dbo.OHEM T5 ON T0.Employee = T5.empID
      INNER JOIN LDS_LIVE.dbo.ITM8 T6 ON T0.ItemCode = T6.ItemCode AND T6.DprArea = 'Main Area'
      LEFT JOIN LDS_LIVE.dbo.DRN2 D1 ON D1.ItemCode = T0.ItemCode
      LEFT JOIN LDS_LIVE.dbo.ACQ1 P1 ON T0.ItemCode = P1.ItemCode
      WHERE T0.[ItmsGrpCod] = 100 AND T2.[Name] = 'LAB EQUIPMENT'
        ${statusSql}
        ${searchSql}
      GROUP BY T2.[Name], T3.[Descr], T0.[AsstStatus], T0.[ItemCode], T0.[ItemName], T0.[AssetSerNo], T4.[Location], T5.[firstName], T0.[AcqDate], T0.[U_cat1], T0.[U_Division], T0.[U_Type], T0.[U_ProductLine]
    `;
    const pagedQuery = `
      ${query.replace('SELECT', 'SELECT COUNT(*) OVER() AS TotalCount,')}
      ORDER BY T0.ItemCode
      ${exportAll ? '' : 'OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY'}
    `;
    const result = await request.query(pagedQuery);
    const rows = result.recordset || [];
    const total = rows[0]?.TotalCount || 0;
    res.json({
      success: true,
      data: rows.map(({ TotalCount, ...row }) => row),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    });
  } catch (error) {
    console.error("Error fetching machines data:", error);
    res.status(500).json({ success: false, message: "Failed to fetch machine data" });
  }
};

module.exports = {
  getMachines
};
