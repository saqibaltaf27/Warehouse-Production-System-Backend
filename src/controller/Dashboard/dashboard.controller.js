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

    if (startDate) {
      planWhere.push("CAST(a.PostDate AS DATE) >= @startDate");
      actualWhere.push("CAST(r.DocDate AS DATE) >= @startDate");
    }
    if (endDate) {
      planWhere.push("CAST(a.PostDate AS DATE) <= @endDate");
      actualWhere.push("CAST(r.DocDate AS DATE) <= @endDate");
    }
    if (warehouse && warehouse !== 'All') {
      planWhere.push("a.Warehouse = @warehouse");
    }

    const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
    const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

    // Query: Get distinct POs with their PlannedQty (once per PO) and sum of receipt actuals
    const query = `
      ;WITH PlannedOrders AS (
        SELECT DISTINCT 
          a.DocNum AS PO,
          a.Status,
          a.ItemCode,
          a.ProdName,
          a.PlannedQty,
          CAST(a.PostDate AS DATE) AS CreateDate
        FROM LDS_LIVE.dbo.AWOR a
        JOIN LDS_LIVE.dbo.OWOR b ON a.DocNum = b.DocNum AND b.PlannedQty = a.PlannedQty
        WHERE a.Status <> 'P' AND a.CmpltQty = 0.00 ${planCond}
      ),
      ReceiptOrders AS (
        SELECT
          r.BaseRef AS PONo,
          SUM(r.Quantity) AS ActualQty
        FROM LDS_LIVE.dbo.IGN1 r
        WHERE r.BaseType = 202 AND r.TranType = 'C' ${actualCond}
        GROUP BY r.BaseRef
      )
      SELECT 
        p.PO,
        p.ItemCode,
        p.ProdName,
        p.PlannedQty,
        p.CreateDate,
        ISNULL(r.ActualQty, 0) AS ActualQty
      FROM PlannedOrders p
      JOIN ReceiptOrders r ON CAST(p.PO AS NVARCHAR) = r.PONo
      ORDER BY p.PO DESC
    `;

    const result = await request.query(query);
    
    // Process PO Breakdown and Aggregate Totals
    let totalPlan = 0;
    let totalActual = 0;
    
    const poBreakdown = result.recordset.map(row => {
      totalPlan += row.PlannedQty;
      totalActual += row.ActualQty;
      
      return {
        po: row.PO,
        itemCode: row.ItemCode,
        prodName: row.ProdName,
        plan: row.PlannedQty,
        actual: row.ActualQty,
        achievement: row.PlannedQty > 0 ? ((row.ActualQty / row.PlannedQty) * 100).toFixed(2) : 0
      };
    });

    const totalOrders = poBreakdown.length;
    const achievement = totalPlan > 0 ? (totalActual / totalPlan) * 100 : 0;

    // Advanced Metrics using the user's query
    let prodWhere = [];
    let capWhere = [];
    if (startDate) {
        prodWhere.push("T0.PostDate >= @startDate");
        capWhere.push("CapDate >= @startDate");
    }
    if (endDate) {
        prodWhere.push("T0.PostDate < DATEADD(DAY, 1, @endDate)");
        capWhere.push("CapDate < DATEADD(DAY, 1, @endDate)");
    }
    if (warehouse && warehouse !== 'All') {
        prodWhere.push("T0.Warehouse = @warehouse");
        // ORCJ typically doesn't have Warehouse, leaving it out
    }
    const prodCond = prodWhere.length > 0 ? ' WHERE ' + prodWhere.join(' AND ') : '';
    const capCond = capWhere.length > 0 ? ' WHERE ' + capWhere.join(' AND ') : '';

    const metricsQuery = `
      ;WITH Prod AS
      (
          SELECT
              SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
              SUM(ISNULL(T0.CmpltQty, 0))   AS CompletedQty,
              SUM(ISNULL(T0.RjctQty, 0))    AS RejectedQty
          FROM LDS_LIVE.dbo.OWOR T0
          ${prodCond}
      ),
      Cap AS
      (
          SELECT
              SUM(CASE WHEN CapType = 'C' AND ActionType = 1 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS CommittedCapacity,
              SUM(CASE WHEN CapType = 'U' AND ActionType = 7 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS ConsumedCapacity
          FROM LDS_LIVE.dbo.ORCJ
          ${capCond}
      )
      SELECT
          CAST(CASE WHEN ISNULL(P.PlannedQty, 0) = 0 THEN 0 ELSE ISNULL(P.CompletedQty, 0) * 100.0 / NULLIF(P.PlannedQty, 0) END AS DECIMAL(18,2)) AS DailyEfficiency,
          CAST(CASE WHEN ISNULL(P.PlannedQty, 0) = 0 OR ISNULL(P.CompletedQty, 0) = 0 THEN 0 ELSE (ISNULL(P.CompletedQty, 0) * 1.0 / NULLIF(P.PlannedQty, 0)) * ((ISNULL(P.CompletedQty, 0) - ISNULL(P.RejectedQty, 0)) * 1.0 / NULLIF(P.CompletedQty, 0)) * 100 END AS DECIMAL(18,2)) AS OEE,
          CAST(CASE WHEN ISNULL(C.CommittedCapacity, 0) = 0 THEN 0 ELSE ISNULL(C.ConsumedCapacity, 0) * 100.0 / NULLIF(C.CommittedCapacity, 0) END AS DECIMAL(18,2)) AS CapacityUtil
      FROM Prod P
      CROSS JOIN Cap C;
    `;
    const metricsResult = await request.query(metricsQuery);
    const metricsData = metricsResult.recordset[0] || { DailyEfficiency: 0, OEE: 0, CapacityUtil: 0 };

    res.status(200).json({
      success: true,
      data: {
        plan: totalPlan,
        actual: totalActual,
        achievement: achievement.toFixed(2),
        totalOrders: totalOrders,
        dailyEfficiency: metricsData.DailyEfficiency,
        oee: metricsData.OEE,
        capacityUtil: metricsData.CapacityUtil,
        poBreakdown: poBreakdown
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

        if (startDate) {
          planWhere.push("CAST(a.PostDate AS DATE) >= @startDate");
          actualWhere.push("CAST(r.DocDate AS DATE) >= @startDate");
        }
        if (endDate) {
          planWhere.push("CAST(a.PostDate AS DATE) <= @endDate");
          actualWhere.push("CAST(r.DocDate AS DATE) <= @endDate");
        }
        if (warehouse && warehouse !== 'All') {
          planWhere.push("a.Warehouse = @warehouse");
        }

        const planCond = planWhere.length > 0 ? ' AND ' + planWhere.join(' AND ') : '';
        const actualCond = actualWhere.length > 0 ? ' AND ' + actualWhere.join(' AND ') : '';

        const optimizedTrendQuery = `
            ;WITH PlannedOrders AS (
              SELECT DISTINCT 
                a.DocNum AS PO,
                a.PlannedQty,
                CAST(a.PostDate AS DATE) AS CreateDate
              FROM LDS_LIVE.dbo.AWOR a
              JOIN LDS_LIVE.dbo.OWOR b ON a.DocNum = b.DocNum AND b.PlannedQty = a.PlannedQty
              WHERE a.Status <> 'P' AND a.CmpltQty = 0.00 ${planCond}
            ),
            ReceiptOrders AS (
              SELECT
                r.BaseRef AS PONo,
                SUM(r.Quantity) AS ActualQty
              FROM LDS_LIVE.dbo.IGN1 r
              WHERE r.BaseType = 202 AND r.TranType = 'C' ${actualCond}
              GROUP BY r.BaseRef
            )
            SELECT 
              p.CreateDate AS Date,
              SUM(p.PlannedQty) AS PlannedQty,
              SUM(ISNULL(r.ActualQty, 0)) AS ActualQty
            FROM PlannedOrders p
            JOIN ReceiptOrders r ON CAST(p.PO AS NVARCHAR) = r.PONo
            GROUP BY p.CreateDate
            ORDER BY Date ASC
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
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        let whereClauses = [];
        if (startDate) whereClauses.push("T0.PostDate >= @startDate");
        if (endDate) whereClauses.push("T0.PostDate <= @endDate"); 
        if (warehouse && warehouse !== 'All') whereClauses.push("T0.Warehouse = @warehouse");

        const whereString = whereClauses.length > 0 ? ' WHERE ' + whereClauses.join(' AND ') : '';

        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const offset = (page - 1) * pageSize;

        const countQuery = `
            SELECT COUNT(DISTINCT CAST(T0.PostDate AS DATE)) as totalRecords
            FROM LDS_LIVE.dbo.OWOR T0
            ${whereString}
        `;
        const countResult = await request.query(countQuery);
        const totalRecords = countResult.recordset[0]?.totalRecords || 0;

        const efficiencyQuery = `
            SELECT
                CAST(T0.PostDate AS DATE) AS [Date],
                CAST(SUM(ISNULL(T0.PlannedQty, 0)) AS DECIMAL(18,2)) AS [Planned Qty],
                CAST(SUM(ISNULL(T0.CmpltQty, 0)) AS DECIMAL(18,2)) AS [Completed Qty],
                CAST(
                    CASE
                        WHEN SUM(ISNULL(T0.PlannedQty, 0)) = 0 THEN 0
                        ELSE SUM(ISNULL(T0.CmpltQty, 0)) * 100.0 / NULLIF(SUM(ISNULL(T0.PlannedQty, 0)), 0)
                    END
                    AS DECIMAL(18,2)
                ) AS [Daily Efficiency]
            FROM LDS_LIVE.dbo.OWOR T0
            ${whereString}
            GROUP BY CAST(T0.PostDate AS DATE)
            ORDER BY [Date]
        `;

        const paginatedQuery = `
            ${efficiencyQuery}
            OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
        `;

        const chartResult = await request.query(efficiencyQuery);
        const tableResult = await request.query(paginatedQuery);
        
        const chartData = chartResult.recordset.map(row => ({
            date: new Date(row.Date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            efficiency: row['Daily Efficiency'],
            plannedQty: row['Planned Qty'],
            completedQty: row['Completed Qty']
        }));

        const tableData = tableResult.recordset.map(row => ({
            date: new Date(row.Date).toISOString().split('T')[0],
            efficiency: row['Daily Efficiency'],
            plannedQty: row['Planned Qty'],
            completedQty: row['Completed Qty']
        }));

        res.status(200).json({ 
            success: true, 
            data: {
                chartData,
                tableData,
                pagination: {
                    totalRecords,
                    currentPage: page,
                    pageSize,
                    totalPages: Math.ceil(totalRecords / pageSize)
                }
            } 
        });
    } catch (error) {
        console.error("Error generating efficiency trend:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
exports.getDowntime = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));

        let capWhere = [];
        if (startDate) capWhere.push("CapDate >= @startDate");
        if (endDate) capWhere.push("CapDate <= @endDate");

        const capCond = capWhere.length > 0 ? ' WHERE ' + capWhere.join(' AND ') : '';

        const downtimeQuery = `
          ;WITH ResourceCapacity AS
          (
              SELECT
                  ResCode,
                  SUM(CASE WHEN CapType = 'C' AND ActionType = 1 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS CommittedCapacity,
                  SUM(CASE WHEN CapType = 'U' AND ActionType = 7 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS ConsumedCapacity
              FROM LDS_LIVE.dbo.ORCJ
              ${capCond}
              GROUP BY ResCode
          )
          SELECT TOP 10
              R.ResCode AS [Resource Code],
              ISNULL(M.ResName, R.ResCode) AS [Resource Name],
              CAST(CASE WHEN ISNULL(R.CommittedCapacity, 0) - ISNULL(R.ConsumedCapacity, 0) < 0 THEN 0 ELSE ISNULL(R.CommittedCapacity, 0) - ISNULL(R.ConsumedCapacity, 0) END AS DECIMAL(18,2)) AS [Downtime]
          FROM ResourceCapacity R
          LEFT JOIN LDS_LIVE.dbo.ORSC M ON M.ResCode = R.ResCode
          WHERE ISNULL(R.CommittedCapacity, 0) > 0
            AND (ISNULL(R.CommittedCapacity, 0) - ISNULL(R.ConsumedCapacity, 0)) > 0
          ORDER BY [Downtime] DESC;
        `;

        const result = await request.query(downtimeQuery);
        
        const colors = ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#06b6d4', '#f43f5e'];
        
        const reasons = result.recordset.map((row, idx) => ({
            name: row['Resource Name'] || row['Resource Code'],
            value: row['Downtime'],
            color: colors[idx % colors.length]
        }));
        
        const totalHrs = reasons.reduce((sum, item) => sum + item.value, 0);

        res.status(200).json({ success: true, data: { totalHrs, percentage: 0, reasons } });
    } catch (error) {
        console.error("Error generating downtime:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
exports.getOEE = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const { startDate, endDate, warehouse } = req.query;
        if (startDate) request.input('startDate', sql.DateTime, new Date(startDate));
        if (endDate) request.input('endDate', sql.DateTime, new Date(endDate));
        if (warehouse && warehouse !== 'All') request.input('warehouse', sql.NVarChar, warehouse);

        let prodWhere = [];
        let capWhere = [];
        if (startDate) {
            prodWhere.push("T0.PostDate >= @startDate");
            capWhere.push("CapDate >= @startDate");
        }
        if (endDate) {
            prodWhere.push("T0.PostDate <= @endDate"); // Use <= for accurate date range if passing Date object, though the user had < DATEADD
            capWhere.push("CapDate <= @endDate");
        }
        if (warehouse && warehouse !== 'All') {
            prodWhere.push("T0.Warehouse = @warehouse");
        }
        const prodCond = prodWhere.length > 0 ? ' WHERE ' + prodWhere.join(' AND ') : '';
        const capCond = capWhere.length > 0 ? ' WHERE ' + capWhere.join(' AND ') : '';

        const oeeQuery = `
          ;WITH Prod AS
          (
              SELECT
                  SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
                  SUM(ISNULL(T0.CmpltQty, 0))   AS CompletedQty,
                  SUM(ISNULL(T0.RjctQty, 0))    AS RejectedQty
              FROM LDS_LIVE.dbo.OWOR T0
              ${prodCond}
          ),
          Cap AS
          (
              SELECT
                  SUM(CASE WHEN CapType = 'C' AND ActionType = 1 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS CommittedCapacity,
                  SUM(CASE WHEN CapType = 'U' AND ActionType = 7 AND Capacity < 0 THEN ABS(Capacity) ELSE 0 END) AS ConsumedCapacity
              FROM LDS_LIVE.dbo.ORCJ
              ${capCond}
          ),
          KPI AS
          (
              SELECT
                  CASE WHEN ISNULL(C.CommittedCapacity, 0) = 0 THEN 0 ELSE ISNULL(C.ConsumedCapacity, 0) * 1.0 / NULLIF(C.CommittedCapacity, 0) END AS Availability,
                  CASE WHEN ISNULL(P.PlannedQty, 0) = 0 THEN 0 ELSE ISNULL(P.CompletedQty, 0) * 1.0 / NULLIF(P.PlannedQty, 0) END AS Performance,
                  CASE WHEN ISNULL(P.CompletedQty, 0) = 0 THEN 0 ELSE ((ISNULL(P.CompletedQty, 0) - ISNULL(P.RejectedQty, 0)) * 1.0) / NULLIF(P.CompletedQty, 0) END AS Quality
              FROM Prod P
              CROSS JOIN Cap C
          )
          SELECT
              CAST(Availability * 100 AS DECIMAL(18,2)) AS Availability,
              CAST(Performance * 100 AS DECIMAL(18,2)) AS Performance,
              CAST(Quality * 100 AS DECIMAL(18,2)) AS Quality,
              CAST(Availability * Performance * Quality * 100 AS DECIMAL(18,2)) AS OEE
          FROM KPI;
        `;

        const result = await request.query(oeeQuery);
        const data = result.recordset[0] || { Availability: 0, Performance: 0, Quality: 0, OEE: 0 };

        res.status(200).json({
            success: true, 
            data: { 
                availability: data.Availability, 
                performance: data.Performance, 
                quality: data.Quality, 
                oee: data.OEE 
            } 
        });
    } catch (error) {
        console.error("Error generating OEE breakdown:", error);
        res.status(500).json({ success: false, message: error.message });
    }
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
