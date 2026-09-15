const { sql, poolPromise } = require('../../database/connection');

// Helper to construct WHERE conditions based on query params
function buildWhereClause(query, request, tableAlias = 'h') {
  const {
    dateFrom,
    dateTo,
    year,
    month,
    product,
    warehouse,
    status,
    search
  } = query;

  let conditions = [];

  if (search) {
    conditions.push(`(CAST(${tableAlias}.DocNum AS VARCHAR) LIKE @search OR ${tableAlias}.ItemCode LIKE @search)`);
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  if (dateFrom) {
    conditions.push(`${tableAlias}.PostDate >= @dateFrom`);
    request.input('dateFrom', sql.DateTime, new Date(dateFrom));
  }
  if (dateTo) {
    conditions.push(`${tableAlias}.PostDate <= @dateTo`);
    request.input('dateTo', sql.DateTime, new Date(dateTo));
  }
  if (year) {
    conditions.push(`YEAR(${tableAlias}.PostDate) = @year`);
    request.input('year', sql.Int, year);
  }
  if (month) {
    conditions.push(`MONTH(${tableAlias}.PostDate) = @month`);
    request.input('month', sql.Int, month);
  }
  if (product) {
    conditions.push(`${tableAlias}.ItemCode = @product`);
    request.input('product', sql.NVarChar, product);
  }
  if (warehouse) {
    conditions.push(`${tableAlias}.Warehouse = @warehouse`);
    request.input('warehouse', sql.NVarChar, warehouse);
  }
  if (status) {
    conditions.push(`${tableAlias}.Status = @status`);
    request.input('status', sql.Char, status);
  } else {
    // Default: look at completed/closed orders mostly, or all non-planned
    // Let's include everything except Planned ('P') by default for costing
    conditions.push(`${tableAlias}.Status <> 'P'`);
  }

  return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
}

exports.getSummaryKPIs = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const whereClause = buildWhereClause(req.query, request, 'o');
    
    const query = `
      WITH ActualCosts AS (
        SELECT BaseEntry, SUM(LineTotal) as ActualCost
        FROM LDS_LIVE.dbo.IGE1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      ),
      PlannedCosts AS (
        SELECT w.DocEntry, 
               SUM(w.PlannedQty * ISNULL(CASE WHEN w.ItemType = 290 THEN r.StdCost1 ELSE i.AvgPrice END, 0)) as PlannedCost
        FROM LDS_LIVE.dbo.WOR1 w
        LEFT JOIN LDS_LIVE.dbo.OITM i ON w.ItemCode = i.ItemCode AND w.ItemType = 4
        LEFT JOIN LDS_LIVE.dbo.ORSC r ON w.ItemCode = r.ResCode AND w.ItemType = 290
        GROUP BY w.DocEntry
      ),
      FGProduced AS (
        SELECT BaseEntry, SUM(Quantity) as FGQty
        FROM LDS_LIVE.dbo.IGN1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      )
      SELECT 
        COUNT(o.DocEntry) as TotalOrders,
        ISNULL(SUM(a.ActualCost), 0) as TotalActualCost,
        ISNULL(SUM(p.PlannedCost), 0) as TotalPlannedCost,
        ISNULL(SUM(f.FGQty), 0) as TotalFGProduced,
        ISNULL(SUM(o.PlannedQty), 0) as TotalPlannedFGQty,
        ISNULL(SUM(CASE WHEN o.Status = 'R' THEN a.ActualCost ELSE 0 END), 0) as TotalWIPCost,
        SUM(CASE WHEN a.ActualCost > 0 AND ISNULL(f.FGQty, 0) = 0 THEN 1 ELSE 0 END) as ZeroReceiptExceptions,
        SUM(CASE WHEN ISNULL(a.ActualCost, 0) = 0 AND f.FGQty > 0 THEN 1 ELSE 0 END) as NoIssueExceptions
      FROM LDS_LIVE.dbo.OWOR o
      LEFT JOIN ActualCosts a ON o.DocEntry = a.BaseEntry
      LEFT JOIN PlannedCosts p ON o.DocEntry = p.DocEntry
      LEFT JOIN FGProduced f ON o.DocEntry = f.BaseEntry
      ${whereClause}
    `;
    
    const result = await request.query(query);
    
    if (result.recordset.length > 0) {
      const data = result.recordset[0];
      const variance = data.TotalPlannedCost > 0 
        ? ((data.TotalActualCost - data.TotalPlannedCost) / data.TotalPlannedCost) * 100 
        : 0;
        
      const yieldPercent = data.TotalPlannedFGQty > 0 
        ? (data.TotalFGProduced / data.TotalPlannedFGQty) * 100 
        : 0;
        
      res.status(200).json({
        success: true,
        data: {
          ...data,
          VariancePercent: variance,
          YieldPercent: yieldPercent,
          AvgUnitCost: data.TotalFGProduced > 0 ? (data.TotalActualCost / data.TotalFGProduced) : 0
        }
      });
    } else {
      res.status(200).json({ success: true, data: null });
    }
  } catch (error) {
    console.error("Error in getSummaryKPIs:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCostTrend = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const whereClause = buildWhereClause(req.query, request, 'o');
    
    const query = `
      WITH ActualCosts AS (
        SELECT BaseEntry, SUM(LineTotal) as ActualCost
        FROM LDS_LIVE.dbo.IGE1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      ),
      PlannedCosts AS (
        SELECT w.DocEntry, 
               SUM(w.PlannedQty * ISNULL(CASE WHEN w.ItemType = 290 THEN r.StdCost1 ELSE i.AvgPrice END, 0)) as PlannedCost
        FROM LDS_LIVE.dbo.WOR1 w
        LEFT JOIN LDS_LIVE.dbo.OITM i ON w.ItemCode = i.ItemCode AND w.ItemType = 4
        LEFT JOIN LDS_LIVE.dbo.ORSC r ON w.ItemCode = r.ResCode AND w.ItemType = 290
        GROUP BY w.DocEntry
      )
      SELECT 
        YEAR(o.PostDate) as Year,
        MONTH(o.PostDate) as Month,
        ISNULL(SUM(a.ActualCost), 0) as ActualCost,
        ISNULL(SUM(p.PlannedCost), 0) as PlannedCost
      FROM LDS_LIVE.dbo.OWOR o
      LEFT JOIN ActualCosts a ON o.DocEntry = a.BaseEntry
      LEFT JOIN PlannedCosts p ON o.DocEntry = p.DocEntry
      ${whereClause}
      GROUP BY YEAR(o.PostDate), MONTH(o.PostDate)
      ORDER BY Year, Month
    `;
    
    const result = await request.query(query);
    res.status(200).json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Error in getCostTrend:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getProductionOrders = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    const whereClause = buildWhereClause(req.query, request, 'o');
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);

    const countQuery = `SELECT COUNT(*) as totalRecords FROM LDS_LIVE.dbo.OWOR o ${whereClause}`;
    const countResult = await request.query(countQuery);
    const totalRecords = countResult.recordset[0].totalRecords;
    
    const query = `
      WITH ActualIssues AS (
        SELECT BaseEntry, BaseLine, ItemCode, SUM(Quantity) as ActualQty, SUM(LineTotal) as ActualCost
        FROM LDS_LIVE.dbo.IGE1
        WHERE BaseType = 202
        GROUP BY BaseEntry, BaseLine, ItemCode
      ),
      OrderLines AS (
        SELECT 
          w.DocEntry,
          w.LineNum,
          w.ItemCode,
          w.ItemType,
          ISNULL(r.ResType, 'I') as ResType,
          w.PlannedQty,
          ISNULL(a.ActualQty, 0) as ActualQty,
          ISNULL(CASE WHEN w.ItemType = 290 THEN r.StdCost1 ELSE ISNULL(Mat.UnitCost, 0) END, 0) as PlannedPrice,
          (CASE 
             WHEN w.ItemType = 290 THEN ISNULL(a.ActualCost, 0)
             ELSE ISNULL(a.ActualQty, 0) * ISNULL(Mat.UnitCost, 0)
           END) as ActualLineCost
        FROM LDS_LIVE.dbo.OWOR o
        INNER JOIN LDS_LIVE.dbo.WOR1 w ON o.DocEntry = w.DocEntry
        LEFT JOIN LDS_LIVE.dbo.ORSC r ON w.ItemCode = r.ResCode AND w.ItemType = 290
        LEFT JOIN ActualIssues a ON w.DocEntry = a.BaseEntry AND w.LineNum = a.BaseLine AND w.ItemCode = a.ItemCode
        OUTER APPLY (
          SELECT TOP 1 CASE WHEN T0.InQty > 0 THEN T0.TransValue / T0.InQty ELSE 0 END AS UnitCost
          FROM LDS_LIVE.dbo.OINM T0
          WHERE T0.ItemCode = w.ItemCode AND T0.InQty > 0 AND w.ItemType <> 290
          ORDER BY T0.DocDate DESC, T0.TransSeq DESC
        ) as Mat
        ${whereClause}
      ),
      AggregatedCosts AS (
        SELECT 
          DocEntry,
          SUM(PlannedQty * PlannedPrice) as PlannedCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'L' THEN PlannedQty * PlannedPrice ELSE 0 END) as PlannedLabourCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'M' THEN PlannedQty * PlannedPrice ELSE 0 END) as PlannedMachineCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'O' THEN PlannedQty * PlannedPrice ELSE 0 END) as PlannedFOHCost,
          SUM(CASE WHEN ItemType <> 290 THEN PlannedQty * PlannedPrice ELSE 0 END) as PlannedMaterialCost,
          
          SUM(ActualLineCost) as ActualCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'L' THEN ActualLineCost ELSE 0 END) as ActualLabourCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'M' THEN ActualLineCost ELSE 0 END) as ActualMachineCost,
          SUM(CASE WHEN ItemType = 290 AND ResType = 'O' THEN ActualLineCost ELSE 0 END) as ActualFOHCost,
          SUM(CASE WHEN ItemType <> 290 THEN ActualLineCost ELSE 0 END) as ActualMaterialCost
        FROM OrderLines
        GROUP BY DocEntry
      ),
      FGProduced AS (
        SELECT BaseEntry, SUM(Quantity) as FGQty
        FROM LDS_LIVE.dbo.IGN1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      )
      SELECT
        o.DocEntry,
        o.DocNum,
        o.ItemCode as FGItemCode,
        o.Status,
        o.PostDate,
        o.Warehouse,
        o.PlannedQty as PlannedFGQty,
        ISNULL(f.FGQty, 0) as ActualFGQty,
        (CASE WHEN o.PlannedQty > 0 THEN (ISNULL(f.FGQty, 0) / o.PlannedQty) * 100 ELSE 0 END) as YieldPercent,
        ISNULL(p.PlannedCost, 0) as PlannedCost,
        ISNULL(p.PlannedMaterialCost, 0) as PlannedMaterialCost,
        ISNULL(p.PlannedLabourCost, 0) as PlannedLabourCost,
        ISNULL(p.PlannedMachineCost, 0) as PlannedMachineCost,
        ISNULL(p.PlannedFOHCost, 0) as PlannedFOHCost,
        ISNULL(p.ActualCost, 0) as ActualCost,
        ISNULL(p.ActualMaterialCost, 0) as ActualMaterialCost,
        ISNULL(p.ActualLabourCost, 0) as ActualLabourCost,
        ISNULL(p.ActualMachineCost, 0) as ActualMachineCost,
        ISNULL(p.ActualFOHCost, 0) as ActualFOHCost,
        (ISNULL(p.ActualCost, 0) - ISNULL(p.PlannedCost, 0)) as TotalVariance
      FROM LDS_LIVE.dbo.OWOR o
      LEFT JOIN AggregatedCosts p ON o.DocEntry = p.DocEntry
      LEFT JOIN FGProduced f ON o.DocEntry = f.BaseEntry
      ${whereClause}
      ORDER BY o.PostDate DESC, o.DocEntry DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    
    const result = await request.query(query);
    res.status(200).json({ 
      success: true, 
      data: result.recordset,
      pagination: {
        total: totalRecords,
        page,
        limit,
        pages: Math.ceil(totalRecords / limit)
      }
    });
  } catch (error) {
    console.error("Error in getProductionOrders:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOrderMaterials = async (req, res) => {
  try {
    const docEntry = parseInt(req.params.docEntry);
    if (!docEntry) {
      return res.status(400).json({ success: false, message: "DocEntry is required" });
    }

    const pool = await poolPromise;
    
    const query = `
      WITH ActualIssues AS (
        SELECT BaseEntry, BaseLine, ItemCode, SUM(Quantity) as ActualQty, SUM(LineTotal) as ActualCost
        FROM LDS_LIVE.dbo.IGE1
        WHERE BaseType = 202 AND BaseEntry = @docEntry
        GROUP BY BaseEntry, BaseLine, ItemCode
      ),
      OrderLines AS (
        SELECT 
          w.DocEntry,
          w.LineNum,
          w.ItemCode,
          w.ItemType,
          ISNULL(r.ResType, 'I') as ResType,
          w.PlannedQty,
          ISNULL(a.ActualQty, 0) as ActualQty,
          ISNULL(CASE WHEN w.ItemType = 290 THEN r.StdCost1 ELSE ISNULL(Mat.UnitCost, 0) END, 0) as PlannedPrice,
          (CASE 
             WHEN w.ItemType = 290 THEN (CASE WHEN ISNULL(a.ActualQty, 0) > 0 THEN ISNULL(a.ActualCost, 0) / a.ActualQty ELSE 0 END)
             ELSE ISNULL(Mat.UnitCost, 0)
           END) as ActualPrice,
          (CASE 
             WHEN w.ItemType = 290 THEN ISNULL(a.ActualCost, 0)
             ELSE ISNULL(a.ActualQty, 0) * ISNULL(Mat.UnitCost, 0)
           END) as ActualCost
        FROM LDS_LIVE.dbo.WOR1 w
        LEFT JOIN LDS_LIVE.dbo.ORSC r ON w.ItemCode = r.ResCode AND w.ItemType = 290
        LEFT JOIN ActualIssues a ON w.DocEntry = a.BaseEntry AND w.LineNum = a.BaseLine AND w.ItemCode = a.ItemCode
        OUTER APPLY (
          SELECT TOP 1 CASE WHEN T0.InQty > 0 THEN T0.TransValue / T0.InQty ELSE 0 END AS UnitCost
          FROM LDS_LIVE.dbo.OINM T0
          WHERE T0.ItemCode = w.ItemCode AND T0.InQty > 0 AND w.ItemType <> 290
          ORDER BY T0.DocDate DESC, T0.TransSeq DESC
        ) as Mat
        WHERE w.DocEntry = @docEntry AND w.ItemType <> 290
      )
      SELECT 
        LineNum,
        ItemCode,
        ItemType,
        ResType,
        PlannedQty,
        PlannedPrice,
        (PlannedQty * PlannedPrice) as PlannedCost,
        ActualQty,
        ActualPrice,
        ActualCost,
        (ActualCost - (PlannedQty * PlannedPrice)) as TotalVariance,
        ((ActualQty - PlannedQty) * PlannedPrice) as UsageVariance,
        ((ActualPrice - PlannedPrice) * ActualQty) as PriceVariance
      FROM OrderLines
      ORDER BY ItemType, LineNum
    `;
    
    const request = pool.request();
    request.input('docEntry', sql.Int, docEntry);
    const result = await request.query(query);
    
    res.status(200).json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Error in getOrderMaterials:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
