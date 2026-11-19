const sql = require('mssql');
const { poolPromise } = require('../../database/connection');

const RAW_MATERIAL_CTE = `
  DECLARE @Today DATE = CAST(GETDATE() AS DATE);
  DECLARE @Start3M DATE = DATEADD(MONTH, -3, @Today);
  DECLARE @Start6M DATE = DATEADD(MONTH, -6, @Today);

  ;WITH ProductionConsumption AS
  (
      SELECT
          L.ItemCode,
          SUM(CASE WHEN H.DocDate >= @Start3M THEN L.Quantity ELSE 0 END) AS Trend3M,
          SUM(L.Quantity) AS Trend6M
      FROM LDS_LIVE.dbo.OIGE H
      INNER JOIN LDS_LIVE.dbo.IGE1 L
          ON H.DocEntry = L.DocEntry
      WHERE
          H.CANCELED = 'N'
          AND L.BaseType = 202
          AND H.DocDate >= @Start6M
          AND H.DocDate < DATEADD(DAY, 1, @Today)
      GROUP BY L.ItemCode
  )
`;

const RAW_MATERIAL_FROM = `
  FROM LDS_LIVE.dbo.OITM I
  LEFT JOIN ProductionConsumption P
      ON I.ItemCode = P.ItemCode
  WHERE I.U_Cat1 = 'Raw Material'
    AND (
      @Search = N''
      OR I.ItemCode LIKE @Search
      OR I.ItemName LIKE @Search
    )
`;

exports.getRawMaterials = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const search = String(req.query.search || '').trim();
    const exportAll = req.query.all === '1';
    const offset = (page - 1) * pageSize;
    const searchValue = search ? `%${search}%` : '';

    const pool = await poolPromise;

    const counted = await pool.request()
      .input('Search', sql.NVarChar, searchValue)
      .query(`
        ${RAW_MATERIAL_CTE}
        SELECT COUNT(*) AS Total
        ${RAW_MATERIAL_FROM}
      `);

    const result = await pool.request()
      .input('Search', sql.NVarChar, searchValue)
      .input('Offset', sql.Int, offset)
      .input('PageSize', sql.Int, pageSize)
      .query(`
        ${RAW_MATERIAL_CTE}
        SELECT
            I.ItemCode,
            I.ItemName,
            ISNULL(I.OnHand, 0) AS [Available Stock],
            ISNULL(I.IsCommited, 0) AS [Committed],
            ISNULL(P.Trend3M, 0) AS [Trend 3M],
            ISNULL(P.Trend6M, 0) AS [Trend 6M],
            ISNULL(I.OnOrder, 0) AS [On Order]
        ${RAW_MATERIAL_FROM}
        ORDER BY I.ItemCode
        ${exportAll ? '' : 'OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY'}
      `);

    const total = counted.recordset?.[0]?.Total || 0;
    res.json({
      success: true,
      data: result.recordset || [],
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    console.error('Error in getRawMaterials:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to load raw materials' });
  }
};
