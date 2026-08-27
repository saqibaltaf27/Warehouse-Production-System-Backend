const { sql, poolPromise } = require('../../database/connection');

// Helper for filtering
function buildWhereClause(query, request, tableAlias = 'p') {
  const { startDate, endDate, warehouse } = query;
  let conditions = [];

  if (startDate) {
    conditions.push(`${tableAlias}.PostDate >= @startDate`);
    request.input('startDate', sql.DateTime, new Date(startDate));
  }
  if (endDate) {
    conditions.push(`${tableAlias}.PostDate <= @endDate`);
    request.input('endDate', sql.DateTime, new Date(endDate));
  }
  if (warehouse && warehouse !== 'All') {
    conditions.push(`${tableAlias}.Warehouse = @warehouse`);
    request.input('warehouse', sql.NVarChar, warehouse);
  }

  return conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
}

exports.getOverviewData = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    // Add parameters to request
    const { startDate, endDate, warehouse } = req.query;
    if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
    if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
    if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

    const planWhere = [];
    const actualWhere = [];

    if (startDate) planWhere.push("o.PostDate >= @startDate");
    if (endDate) planWhere.push("o.PostDate <= @endDate");
    if (warehouse && warehouse !== 'All') planWhere.push("o.Warehouse = @warehouse");

    if (startDate) actualWhere.push("i.DocDate >= @startDate");
    if (endDate) actualWhere.push("i.DocDate <= @endDate");
    if (warehouse && warehouse !== 'All') actualWhere.push("i.WhsCode = @warehouse");

    const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
    const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

    const query = `
      SELECT 
        (SELECT ISNULL(SUM(o.PlannedQty), 0) FROM LDS_LIVE.dbo.OWOR o WHERE o.Status IN ('R', 'P', 'L', 'C') ${planCond}) as PlannedQty,
        (SELECT ISNULL(SUM(i.Quantity), 0) FROM LDS_LIVE.dbo.IGN1 i WHERE i.BaseType = 202 ${actualCond}) as ActualQty,
        (SELECT COUNT(o.DocEntry) FROM LDS_LIVE.dbo.OWOR o WHERE o.Status IN ('R', 'P', 'L', 'C') ${planCond}) as TotalOrders
    `;

    const result = await request.query(query);
    const data = result.recordset[0] || { PlannedQty: 0, ActualQty: 0, TotalOrders: 0 };
    
    // Achievement
    const achievement = data.PlannedQty > 0 ? (data.ActualQty / data.PlannedQty) * 100 : 0;

    res.status(200).json({
      success: true,
      data: {
        plan: data.PlannedQty,
        actual: data.ActualQty,
        achievement: achievement.toFixed(2),
        totalOrders: data.TotalOrders
      }
    });
  } catch (error) {
    console.error("Error generating dashboard overview:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAlerts = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const whereClause = buildWhereClause(req.query, request, 'o');
        const finalWhere = whereClause ? `AND ${whereClause.substring(4)}` : '';

        // 1. Orders Delayed
        const delayedQuery = `
            SELECT COUNT(o.DocEntry) as Count
            FROM LDS_LIVE.dbo.OWOR o
            WHERE o.Status IN ('R', 'P') AND o.DueDate < CAST(GETDATE() AS DATE) AND o.CmpltQty < o.PlannedQty ${finalWhere}
        `;
        const delayedResult = await request.query(delayedQuery);
        
        // 2. Material Shortage
        const warehouseFilter = req.query.warehouse && req.query.warehouse !== 'All' ? `AND w.WhsCode = @warehouse` : '';
        const shortageQuery = `
             SELECT COUNT(*) as Count FROM (
                 SELECT m.ItemCode
                 FROM LDS_LIVE.dbo.OITW w
                 INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode
                 WHERE 1=1 ${warehouseFilter}
                 GROUP BY m.ItemCode
                 HAVING SUM(w.OnHand) < SUM(w.IsCommited)
             ) t
        `;
        const shortageResult = await request.query(shortageQuery);

        // 3. Orders Over Standard Cost (Variance > 5%)
        const costQuery = `
             SELECT COUNT(*) as Count
             FROM (
                 SELECT 
                     o.DocEntry,
                     ISNULL((SELECT SUM(w.PlannedQty * m.AvgPrice) FROM LDS_LIVE.dbo.WOR1 w INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode WHERE w.DocEntry = o.DocEntry), 0) as StdCost,
                     ISNULL((SELECT SUM(i.LineTotal) FROM LDS_LIVE.dbo.IGE1 i WHERE i.BaseEntry = o.DocEntry AND i.BaseType = 202), 0) as ActualCost
                 FROM LDS_LIVE.dbo.OWOR o
                 WHERE o.Status IN ('L', 'C') ${finalWhere}
             ) t
             WHERE t.StdCost > 0 AND ((t.ActualCost - t.StdCost) / t.StdCost) > 0.05
        `;
        const costResult = await request.query(costQuery);
        
        // 4. Quality Issues
        const qualityQuery = `
            SELECT COUNT(o.DocEntry) as Count
            FROM LDS_LIVE.dbo.OWOR o
            WHERE o.Status IN ('R', 'L', 'P', 'C') AND o.RjctQty > 0 ${finalWhere}
        `;
        const qualityResult = await request.query(qualityQuery);


        res.status(200).json({
            success: true,
            data: {
                delayedOrders: delayedResult.recordset[0]?.Count || 0,
                materialShortages: shortageResult.recordset[0]?.Count || 0,
                ordersOverCost: costResult.recordset[0]?.Count || 0,
                highDowntime: 0, // Unavailable
                qualityIssues: qualityResult.recordset[0]?.Count || 0
            }
        });
    } catch (error) {
        console.error("Error generating alerts:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getPlanVsActual = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        const planWhere = [];
        const actualWhere = [];

        if (startDate) planWhere.push("PostDate >= @startDate");
        if (endDate) planWhere.push("PostDate <= @endDate");
        if (warehouse && warehouse !== 'All') planWhere.push("Warehouse = @warehouse");

        if (startDate) actualWhere.push("DocDate >= @startDate");
        if (endDate) actualWhere.push("DocDate <= @endDate");
        if (warehouse && warehouse !== 'All') actualWhere.push("WhsCode = @warehouse");

        const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
        const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

        const optimizedTrendQuery = `
           SELECT 
                ISNULL(p.DateValue, a.DateValue) as Date,
                ISNULL(p.PlannedQty, 0) as PlannedQty,
                ISNULL(a.ActualQty, 0) as ActualQty
            FROM (
                SELECT CAST(PostDate AS DATE) as DateValue, SUM(PlannedQty) as PlannedQty
                FROM LDS_LIVE.dbo.OWOR 
                WHERE Status IN ('R', 'P', 'L', 'C') ${planCond}
                GROUP BY CAST(PostDate AS DATE)
            ) p
            FULL OUTER JOIN (
                SELECT CAST(DocDate AS DATE) as DateValue, SUM(Quantity) as ActualQty
                FROM LDS_LIVE.dbo.IGN1
                WHERE BaseType = 202 ${actualCond}
                GROUP BY CAST(DocDate AS DATE)
            ) a ON p.DateValue = a.DateValue
            ORDER BY Date
        `;
        const result = await request.query(optimizedTrendQuery);

        res.status(200).json({
            success: true,
            data: result.recordset.map(row => ({
                date: row.Date,
                plannedQty: row.PlannedQty,
                actualQty: row.ActualQty
            }))
        });
    } catch (error) {
        console.error("Error generating plan vs actual:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};


exports.getCostSummary = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        const planWhere = [];
        const actualWhere = [];

        if (startDate) planWhere.push("o.PostDate >= @startDate");
        if (endDate) planWhere.push("o.PostDate <= @endDate");
        if (warehouse && warehouse !== 'All') planWhere.push("o.Warehouse = @warehouse");

        if (startDate) actualWhere.push("i.DocDate >= @startDate");
        if (endDate) actualWhere.push("i.DocDate <= @endDate");
        if (warehouse && warehouse !== 'All') actualWhere.push("i.WhsCode = @warehouse");

        const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
        const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

        // Standard Material Cost (WOR1 * OITM.AvgPrice)
        const stdCostQuery = `
            SELECT ISNULL(SUM(w.PlannedQty * m.AvgPrice), 0) as StandardMaterialCost,
                   ISNULL(SUM(w.PlannedQty), 0) as TotalUnits
            FROM LDS_LIVE.dbo.WOR1 w
            INNER JOIN LDS_LIVE.dbo.OWOR o ON w.DocEntry = o.DocEntry
            INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode
            WHERE o.Status IN ('R', 'L', 'P', 'C') ${planCond}
        `;
        const stdCostResult = await request.query(stdCostQuery);
        const stdMaterialCost = stdCostResult.recordset[0]?.StandardMaterialCost || 0;
        const totalUnits = stdCostResult.recordset[0]?.TotalUnits || 1;

        // Actual Material Cost (IGE1.LineTotal)
        const actCostQuery = `
            SELECT ISNULL(SUM(i.LineTotal), 0) as ActualMaterialCost,
                   ISNULL(SUM(i.Quantity), 0) as ActualUnits
            FROM LDS_LIVE.dbo.IGE1 i
            WHERE i.BaseType = 202 ${actualCond}
        `;
        const actCostResult = await request.query(actCostQuery);
        const actMaterialCost = actCostResult.recordset[0]?.ActualMaterialCost || 0;
        const actualUnits = actCostResult.recordset[0]?.ActualUnits || 1;

        const materialVariance = actMaterialCost - stdMaterialCost;
        const materialVariancePercent = stdMaterialCost > 0 ? (materialVariance / stdMaterialCost) * 100 : 0;

        res.status(200).json({
            success: true,
            data: {
                material: {
                    standard: stdMaterialCost,
                    actual: actMaterialCost,
                    variance: materialVariance,
                    variancePercent: materialVariancePercent.toFixed(2)
                },
                labor: { standard: 0, actual: 0, variance: 0, variancePercent: 0 },
                overhead: { standard: 0, actual: 0, variance: 0, variancePercent: 0 },
                total: {
                    standard: stdMaterialCost,
                    actual: actMaterialCost,
                    variance: materialVariance,
                    variancePercent: materialVariancePercent.toFixed(2)
                },
                perUnit: {
                    standard: stdMaterialCost / (totalUnits > 0 ? totalUnits : 1),
                    actual: actMaterialCost / (actualUnits > 0 ? actualUnits : 1),
                    variance: (actMaterialCost / (actualUnits > 0 ? actualUnits : 1)) - (stdMaterialCost / (totalUnits > 0 ? totalUnits : 1)),
                }
            }
        });
    } catch (error) {
        console.error("Error generating cost summary:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getCostVariance = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        const planWhere = [];
        if (startDate) planWhere.push("o.PostDate >= @startDate");
        if (endDate) planWhere.push("o.PostDate <= @endDate");
        if (warehouse && warehouse !== 'All') planWhere.push("o.Warehouse = @warehouse");
        const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';

        const varianceQuery = `
            SELECT TOP 5
                t.OrderNum,
                t.Product,
                t.StdCost,
                t.ActualCost,
                CASE WHEN t.StdCost > 0 
                     THEN ((t.ActualCost - t.StdCost) / t.StdCost) * 100 
                     ELSE 0 
                END as VariancePercent
            FROM (
                SELECT 
                    o.DocNum as OrderNum,
                    o.ItemCode as Product,
                    ISNULL((SELECT SUM(w.PlannedQty * m.AvgPrice) FROM LDS_LIVE.dbo.WOR1 w INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode WHERE w.DocEntry = o.DocEntry), 0) as StdCost,
                    ISNULL((SELECT SUM(i.LineTotal) FROM LDS_LIVE.dbo.IGE1 i WHERE i.BaseEntry = o.DocEntry AND i.BaseType = 202), 0) as ActualCost
                FROM LDS_LIVE.dbo.OWOR o
                WHERE o.Status IN ('L', 'C') ${planCond}
            ) t
            ORDER BY VariancePercent DESC, t.OrderNum DESC
        `;
        const result = await request.query(varianceQuery);

        const data = result.recordset.map(row => {
            return {
                OrderNum: row.OrderNum,
                Product: row.Product,
                StdCost: row.StdCost,
                ActualCost: row.ActualCost,
                VariancePercent: row.VariancePercent.toFixed(2)
            };
        });

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Error generating cost variance:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getMaterialShortages = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const warehouseFilter = req.query.warehouse && req.query.warehouse !== 'All' ? `AND w.WhsCode = @warehouse` : '';
        if(req.query.warehouse && req.query.warehouse !== 'All') request.input('warehouse', sql.NVarChar, req.query.warehouse);

        const shortageQuery = `
             SELECT TOP 10
                 m.ItemCode,
                 m.ItemName,
                 ISNULL(SUM(w.IsCommited), 0) as RequiredQty,
                 ISNULL(SUM(w.OnHand), 0) as AvailableQty,
                 ISNULL(SUM(w.IsCommited), 0) - ISNULL(SUM(w.OnHand), 0) as Shortage
             FROM LDS_LIVE.dbo.OITW w
             INNER JOIN LDS_LIVE.dbo.OITM m ON w.ItemCode = m.ItemCode
             WHERE 1=1 ${warehouseFilter}
             GROUP BY m.ItemCode, m.ItemName
             HAVING SUM(w.OnHand) < SUM(w.IsCommited)
             ORDER BY Shortage DESC
        `;
        const result = await request.query(shortageQuery);

        res.status(200).json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error("Error generating shortages:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getEfficiency = async (req, res) => {
    res.status(200).json({ success: true, data: [] });
};
exports.getDowntime = async (req, res) => {
    res.status(200).json({ success: true, data: { totalHrs: 0, percentage: 0, reasons: [] } });
};
exports.getOEE = async (req, res) => {
    res.status(200).json({ success: true, data: { availability: 0, performance: 0, quality: 0, oee: 0 } });
};

exports.getQuality = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        const planWhere = [];
        const actualWhere = [];

        if (startDate) planWhere.push("o.PostDate >= @startDate");
        if (endDate) planWhere.push("o.PostDate <= @endDate");
        if (warehouse && warehouse !== 'All') planWhere.push("o.Warehouse = @warehouse");

        if (startDate) actualWhere.push("i.DocDate >= @startDate");
        if (endDate) actualWhere.push("i.DocDate <= @endDate");
        if (warehouse && warehouse !== 'All') actualWhere.push("i.WhsCode = @warehouse");

        const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
        const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

        const qualityQuery = `
            SELECT 
                (SELECT ISNULL(SUM(o.PlannedQty), 0) FROM LDS_LIVE.dbo.OWOR o WHERE o.Status IN ('R', 'P', 'L', 'C') ${planCond}) as TotalPlanned,
                (SELECT ISNULL(SUM(i.Quantity), 0) FROM LDS_LIVE.dbo.IGN1 i WHERE i.BaseType = 202 ${actualCond}) as TotalProduced,
                (SELECT ISNULL(SUM(o.RjctQty), 0) FROM LDS_LIVE.dbo.OWOR o WHERE o.Status IN ('R', 'P', 'L', 'C') ${planCond}) as RejectedQty
        `;
        const result = await request.query(qualityQuery);
        const data = result.recordset[0] || { TotalPlanned: 0, TotalProduced: 0, RejectedQty: 0 };
        
        const rejectionPercent = data.TotalProduced > 0 ? (data.RejectedQty / data.TotalProduced) * 100 : 0;
        const firstPassYield = data.TotalProduced > 0 ? ((data.TotalProduced - data.RejectedQty) / data.TotalProduced) * 100 : 0;

        res.status(200).json({
            success: true,
            data: {
                rejectionPercent: rejectionPercent.toFixed(2),
                reworkPercent: "0.00",
                firstPassYield: firstPassYield.toFixed(2),
                rejectedQty: data.RejectedQty,
                reworkedQty: 0,
                totalProduced: data.TotalProduced
            }
        });
    } catch (error) {
        console.error("Error generating quality:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getOrderSummary = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const whereClause = buildWhereClause(req.query, request, 'o');
        const finalWhere = whereClause ? `AND ${whereClause.substring(4)}` : '';

        const summaryQuery = `
            SELECT
                COUNT(o.DocEntry) as TotalOrders,
                SUM(CASE WHEN o.Status = 'R' THEN 1 ELSE 0 END) as InProgress,
                SUM(CASE WHEN o.Status = 'P' THEN 1 ELSE 0 END) as Planned,
                SUM(CASE WHEN o.Status = 'L' THEN 1 ELSE 0 END) as Completed,
                SUM(CASE WHEN o.Status IN ('R', 'P') AND o.DueDate < CAST(GETDATE() AS DATE) AND o.CmpltQty < o.PlannedQty THEN 1 ELSE 0 END) as Delayed
            FROM LDS_LIVE.dbo.OWOR o
            WHERE o.Status IN ('R', 'P', 'L', 'C') ${finalWhere}
        `;
        const result = await request.query(summaryQuery);
        const data = result.recordset[0] || { TotalOrders: 0, InProgress: 0, Planned: 0, Completed: 0, Delayed: 0 };

        res.status(200).json({
            success: true,
            data: {
                totalOrders: data.TotalOrders,
                inProgress: data.InProgress,
                onHold: data.Planned, 
                completed: data.Completed,
                delayed: data.Delayed,
                atRisk: 0 
            }
        });
    } catch (error) {
        console.error("Error generating order summary:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getWarehouses = async (req, res) => {
    try {
        const pool = await poolPromise;
        const query = `SELECT WhsCode as code, WhsName as name FROM LDS_LIVE.dbo.OWHS ORDER BY WhsCode`;
        const result = await pool.request().query(query);

        res.status(200).json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error("Error fetching warehouses:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
