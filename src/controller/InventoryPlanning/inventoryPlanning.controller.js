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

const SORT_COLUMNS = {
  'Product Line': '[Product Line]',
  'Cat#': '[Cat#]',
  ItemCode: 'ItemCode',
  ItemName: 'ItemName',
  'Open Qty': '[Open Qty]',
  Required: '[Required]',
  'Available Stock': '[Available Stock]',
  'On Order': '[On Order]',
  'Trend 3M': '[Trend 3M]',
  'Trend 6M': '[Trend 6M]',
};

const RAW_MATERIAL_FROM = `
  FROM LDS_LIVE.dbo.OITM I
  LEFT JOIN ProductionConsumption P
      ON I.ItemCode = P.ItemCode
  WHERE I.U_Cat1 = 'Raw Material'
    AND (@ProductLine = N'' OR I.U_PROd_LINE = @ProductLine)
    AND (
      @Search = N''
      OR I.ItemCode LIKE @Search
      OR I.ItemName LIKE @Search
    )
`;

exports.getRawMaterials = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100000, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const search = String(req.query.search || '').trim();
    const productLine = String(req.query.productLine || '').trim();
    const sortBy = SORT_COLUMNS[req.query.sortBy] || 'ItemCode';
    const sortOrder = String(req.query.sortOrder || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const exportAll = req.query.all === '1';
    const offset = (page - 1) * pageSize;
    const searchValue = search ? `%${search}%` : '';

    const pool = await poolPromise;

    const lines = await pool.request().query(`
      SELECT DISTINCT I.U_PROd_LINE AS ProductLine
      FROM LDS_LIVE.dbo.OITM I
      WHERE I.U_Cat1 = 'Raw Material'
        AND I.U_PROd_LINE IS NOT NULL
        AND LTRIM(RTRIM(I.U_PROd_LINE)) <> ''
      ORDER BY I.U_PROd_LINE
    `);

    const counted = await pool.request()
      .input('Search', sql.NVarChar, searchValue)
      .input('ProductLine', sql.NVarChar, productLine)
      .query(`
        ${RAW_MATERIAL_CTE}
        SELECT COUNT(*) AS Total
        ${RAW_MATERIAL_FROM}
      `);

    const result = await pool.request()
      .input('Search', sql.NVarChar, searchValue)
      .input('ProductLine', sql.NVarChar, productLine)
      .input('Offset', sql.Int, offset)
      .input('PageSize', sql.Int, pageSize)
      .query(`
        ${RAW_MATERIAL_CTE}
        SELECT
            I.ItemCode,
            I.ItemName,
            I.Frgnname as [Cat#],
            I.U_PROd_LINE as [Product Line], 
            ISNULL(I.OnHand, 0) AS [Available Stock],
            ISNULL((
                SELECT  SUM(rdr1.OpenQty)
                FROM LDS_LIVE.dbo.RDR1 rdr1
                JOIN LDS_LIVE.dbo.ORDR a ON rdr1.DocEntry = a.DocEntry
                JOIN LDS_LIVE.dbo.OITM b ON b.ItemCode = rdr1.ItemCode
                LEFT JOIN LDS_LIVE.dbo.OITT c ON b.ItemCode = c.Code
                LEFT JOIN LDS_LIVE.dbo.ITT1 d ON c.Code = d.Father
                WHERE rdr1.OpenQty > 0
                  AND d.Type = 4
                  AND a.DocStatus = 'O'
                  AND b.U_Cat1 = 'Finished Product'
                  AND d.Code = I.ItemCode
            ), 0) AS [Open Qty],
            ISNULL((
                SELECT TOP 1 SUM(d.Quantity * rdr1.OpenQty)
                FROM LDS_LIVE.dbo.RDR1 rdr1
                JOIN LDS_LIVE.dbo.ORDR a ON rdr1.DocEntry = a.DocEntry
                JOIN LDS_LIVE.dbo.OITM b ON b.ItemCode = rdr1.ItemCode
                LEFT JOIN LDS_LIVE.dbo.OITT c ON b.ItemCode = c.Code
                LEFT JOIN LDS_LIVE.dbo.ITT1 d ON c.Code = d.Father
                WHERE rdr1.OpenQty > 0
                  AND d.Type = 4
                  AND a.DocStatus = 'O'
                  AND b.U_Cat1 = 'Finished Product'
                  AND d.Code = I.ItemCode
            ), 0) AS [Required],
            ISNULL(P.Trend3M, 0) AS [Trend 3M],
            ISNULL(P.Trend6M, 0) AS [Trend 6M],
            ISNULL(I.OnOrder, 0) AS [On Order]
        ${RAW_MATERIAL_FROM}
        ORDER BY ${sortBy} ${sortOrder}${sortBy === 'ItemCode' ? '' : ', ItemCode ASC'}
        ${exportAll ? '' : 'OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY'}
      `);

    const total = counted.recordset?.[0]?.Total || 0;
    res.json({
      success: true,
      data: result.recordset || [],
      productLines: (lines.recordset || []).map((row) => row.ProductLine),
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
