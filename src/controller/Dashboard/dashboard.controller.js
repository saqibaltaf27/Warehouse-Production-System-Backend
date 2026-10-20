const { sql, poolPromise } = require('../../database/connection');
const { formatDate } = require('../../hooks/dateformat');

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

exports.getQcOverview = async (req, res) => {
  try {
    const { month, year } = req.query;
    const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
    const targetYear = year ? parseInt(year) : new Date().getFullYear();

    const pool = await poolPromise;
    const request = pool.request();
    request.input('targetMonth', targetMonth);
    request.input('targetYear', targetYear);

    const result = await request.query(`
      SELECT 
        ISNULL(G.ItmsGrpNam, 'OTHERS') AS ItemGroup,
        I.ItemName AS ProductName,
        SUM(O.PlannedQty) AS PlannedQty,
        CASE 
          WHEN SUM(ISNULL(IGN.ProducedQty, 0)) > SUM(O.PlannedQty) THEN SUM(O.PlannedQty)
          ELSE SUM(ISNULL(IGN.ProducedQty, 0))
        END AS CompletedQty,
        CASE 
          WHEN SUM(ISNULL(IGN.ProducedQty, 0)) > SUM(O.PlannedQty) THEN SUM(ISNULL(IGN.ProducedQty, 0)) - SUM(O.PlannedQty)
          ELSE 0
        END AS OverProducedQty,
        CASE 
          WHEN SUM(O.PlannedQty) - SUM(ISNULL(IGN.ProducedQty, 0)) < 0 THEN 0 
          ELSE SUM(O.PlannedQty) - SUM(ISNULL(IGN.ProducedQty, 0)) 
        END AS InProcessQty,
        SUM(ISNULL(IGN.TotalCost, 0)) AS ResourceValue,
        SUM(ISNULL(IGN.TotalCost, 0)) / NULLIF(SUM(ISNULL(IGN.ProducedQty, 0)), 0) AS CostPerBox
      FROM LDS_LIVE.dbo.OWOR O
      LEFT JOIN LDS_LIVE.dbo.OITM I ON O.ItemCode = I.ItemCode
      LEFT JOIN LDS_LIVE.dbo.OITB G ON I.ItmsGrpCod = G.ItmsGrpCod
      LEFT JOIN (
        SELECT BaseEntry, SUM(Quantity) AS ProducedQty, SUM(LineTotal) AS TotalCost
        FROM LDS_LIVE.dbo.IGN1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      ) IGN ON O.DocEntry = IGN.BaseEntry
      WHERE MONTH(O.PostDate) = @targetMonth AND YEAR(O.PostDate) = @targetYear
        AND G.ItmsGrpNam LIKE 'FG%'
      GROUP BY G.ItmsGrpNam, I.ItemName
    `);

    res.status(200).json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error in getQcOverview:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTopProductsCostTrend = async (req, res) => {
  try {
    const { month, year } = req.query;
    const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
    const targetYear = year ? parseInt(year) : new Date().getFullYear();

    const pool = await poolPromise;
    const request = pool.request();
    request.input('targetMonth', targetMonth);
    request.input('targetYear', targetYear);

    // 1. Get top 2 products by CompletedQty
    const topProductsQuery = `
      SELECT TOP 2
        I.ItemCode,
        I.ItemName
      FROM LDS_LIVE.dbo.OWOR O
      LEFT JOIN LDS_LIVE.dbo.OITM I ON O.ItemCode = I.ItemCode
      LEFT JOIN LDS_LIVE.dbo.OITB G ON I.ItmsGrpCod = G.ItmsGrpCod
      LEFT JOIN (
        SELECT BaseEntry, SUM(Quantity) AS ProducedQty
        FROM LDS_LIVE.dbo.IGN1
        WHERE BaseType = 202
        GROUP BY BaseEntry
      ) IGN ON O.DocEntry = IGN.BaseEntry
      WHERE MONTH(O.PostDate) = @targetMonth AND YEAR(O.PostDate) = @targetYear
        AND G.ItmsGrpNam LIKE 'FG%'
      GROUP BY I.ItemCode, I.ItemName
      ORDER BY SUM(ISNULL(IGN.ProducedQty, 0)) DESC
    `;
    const topProductsResult = await request.query(topProductsQuery);
    const topProducts = topProductsResult.recordset;

    if (topProducts.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // 2. Fetch recent PO trends for these products
    let finalData = [];
    for (let product of topProducts) {
      const trendReq = pool.request();
      trendReq.input('targetMonth', targetMonth);
      trendReq.input('targetYear', targetYear);
      trendReq.input('itemCode', product.ItemCode);
      const trendQuery = `
        SELECT 
          CAST(O.DocNum AS VARCHAR(20)) AS po,
          CAST(SUM(ISNULL(IGN.TotalCost, 0)) / NULLIF(SUM(ISNULL(IGN.ProducedQty, 0)), 0) AS FLOAT) AS cost,
          CAST(SUM(ISNULL(IGN.ProducedQty, 0)) AS FLOAT) AS completedQty
        FROM LDS_LIVE.dbo.OWOR O
        LEFT JOIN (
          SELECT BaseEntry, SUM(Quantity) AS ProducedQty, SUM(LineTotal) AS TotalCost
          FROM LDS_LIVE.dbo.IGN1
          WHERE BaseType = 202
          GROUP BY BaseEntry
        ) IGN ON O.DocEntry = IGN.BaseEntry
        WHERE O.ItemCode = @itemCode
          AND MONTH(O.PostDate) = @targetMonth AND YEAR(O.PostDate) = @targetYear
          AND ISNULL(IGN.ProducedQty, 0) > 0
        GROUP BY O.DocNum
        ORDER BY O.DocNum ASC
      `;
      const trendResult = await trendReq.query(trendQuery);
      finalData.push({
        itemName: product.ItemName,
        trends: trendResult.recordset
      });
    }

    res.status(200).json({ success: true, data: finalData });
  } catch (error) {
    console.error("Error in getTopProductsCostTrend:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMonthlyProductionAchievement = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!month || !year || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "month and year are required" });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input("month", sql.Int, month)
      .input("year", sql.Int, year)
      .query(`
        DECLARE @start DATE = DATEFROMPARTS(@year, @month, 1);
        DECLARE @end DATE = DATEADD(MONTH, 1, @start);

        SELECT
          T0.DocNum AS ProductionOrderNo,
          T0.ItemCode,
          T0.ProdName AS ProductName,
          T0.DueDate,
          T0.CloseDate,
          CASE T0.Status
            WHEN 'P' THEN 'Planned'
            WHEN 'R' THEN 'Released'
            WHEN 'L' THEN 'Closed'
            WHEN 'C' THEN 'Cancelled'
            ELSE ISNULL(T0.Status, 'Unknown')
          END AS StatusName,
          T0.PlannedQty,
          T0.CmpltQty AS CompletedQty,
          CASE
            WHEN T0.Status = 'L' AND T0.CloseDate >= @start AND T0.CloseDate < @end THEN 1
            ELSE 0
          END AS ClosedInMonth
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @start AND T0.DueDate < @end
        ORDER BY T0.DueDate, T0.DocNum
      `);

    const orders = (result.recordset || []).map((row) => ({
      ...row,
      DueDate: formatDate(row.DueDate),
      CloseDate: formatDate(row.CloseDate),
    }));
    const dueInMonth = orders.length;
    const closedInMonth = orders.filter((row) => Number(row.ClosedInMonth) === 1).length;
    const achievement = dueInMonth > 0 ? Number(((closedInMonth / dueInMonth) * 100).toFixed(1)) : 0;

    res.status(200).json({
      success: true,
      data: { dueInMonth, closedInMonth, achievement, orders },
    });
  } catch (error) {
    console.error("Error in getMonthlyProductionAchievement:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMonthlySampleStatus = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!month || !year || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "month and year are required" });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input("month", sql.Int, month)
      .input("year", sql.Int, year)
      .query(`
        DECLARE @start DATE = DATEFROMPARTS(@year, @month, 1);
        DECLARE @end DATE = DATEADD(MONTH, 1, @start);

        SELECT b.U_status AS StatusCode, COUNT(*) AS LineCount
        FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
        INNER JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry = b.DocEntry
        WHERE a.U_SmpDate >= @start AND a.U_SmpDate < @end
          AND b.U_status IN ('S', 'UI', 'A', 'R', 'P', 'CA', 'CR', 'C')
        GROUP BY b.U_status;

        SELECT
          a.DocNum AS SamplingNo,
          a.U_SmpDate AS SamplingDate,
          b.U_ItemCode AS ItemCode,
          b.U_ItemName AS ItemName,
          b.U_Batch AS Batch,
          b.U_SmpQty AS SampleQty,
          CASE b.U_status
            WHEN 'S' THEN 'Sampled'
            WHEN 'UI' THEN 'Under Inspection'
            WHEN 'A' THEN 'Accepted'
            WHEN 'R' THEN 'Rejected'
            WHEN 'P' THEN 'Pending'
            WHEN 'CA' THEN 'Conditionally Accepted'
            WHEN 'CR' THEN 'Conditionally Rejected'
            WHEN 'C' THEN 'Cancel'
          END AS StatusName,
          CASE a.U_Type
            WHEN 20 THEN 'Goods Receipt PO'
            WHEN 59 THEN 'Receipt From Production'
            WHEN 16 THEN 'Sales Return'
            WHEN 14 THEN 'A/R Credit Memo'
            ELSE CAST(a.U_Type AS NVARCHAR(20))
          END AS DocumentType,
          a.U_DocNum AS DocumentNo,
          a.U_CardName AS SupplierName
        FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
        INNER JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry = b.DocEntry
        WHERE a.U_SmpDate >= @start AND a.U_SmpDate < @end
          AND b.U_status IN ('S', 'UI', 'A', 'R', 'P', 'CA', 'CR', 'C')
        ORDER BY a.U_SmpDate, a.DocNum
      `);

    const labels = {
      S: "Sampled",
      UI: "Under Inspection",
      A: "Accepted",
      R: "Rejected",
      P: "Pending",
      CA: "Conditionally Accepted",
      CR: "Conditionally Rejected",
      C: "Cancel",
    };
    const counts = Object.fromEntries(Object.keys(labels).map((code) => [code, 0]));
    (result.recordsets?.[0] || []).forEach((row) => {
      const code = row.StatusCode || "";
      if (Object.prototype.hasOwnProperty.call(counts, code)) {
        counts[code] = Number(row.LineCount) || 0;
      }
    });
    counts.S = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const samples = (result.recordsets?.[1] || []).map((row) => ({
      ...row,
      SamplingDate: formatDate(row.SamplingDate),
    }));

    res.status(200).json({
      success: true,
      data: {
        cards: Object.entries(labels).map(([code, label]) => ({
          code,
          label,
          count: counts[code],
        })),
        samples,
      },
    });
  } catch (error) {
    console.error("Error in getMonthlySampleStatus:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMonthlyProductionAnalytics = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!month || !year || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "month and year are required" });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input("month", sql.Int, month)
      .input("year", sql.Int, year)
      .query(`
        DECLARE @start DATE = DATEFROMPARTS(@year, @month, 1);
        DECLARE @end DATE = DATEADD(MONTH, 1, @start);
        DECLARE @prevStart DATE = DATEADD(MONTH, -1, @start);
        DECLARE @trendStart DATE = DATEADD(MONTH, -11, @start);
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        SELECT
          SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
          SUM(ISNULL(T0.CmpltQty, 0)) AS CompletedQty,
          SUM(CASE WHEN ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS RemainingQty,
          SUM(CASE WHEN T0.Status = 'R' AND ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS InProcessQty,
          SUM(CASE WHEN T0.Status = 'R' THEN 1 ELSE 0 END) AS InProgressOrders,
          SUM(CASE WHEN T0.Status = 'L' AND T0.CloseDate >= @start AND T0.CloseDate < @end THEN 1 ELSE 0 END) AS ClosedOrders
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @start AND T0.DueDate < @end AND T0.Status <> 'C';

        SELECT
          SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
          SUM(ISNULL(T0.CmpltQty, 0)) AS CompletedQty,
          SUM(CASE WHEN T0.Status IN ('R', 'P') AND T0.DueDate < @today AND ISNULL(T0.CmpltQty, 0) < ISNULL(T0.PlannedQty, 0) THEN 1 ELSE 0 END) AS DelayedOrders,
          SUM(CASE WHEN T0.Status = 'L' AND T0.CloseDate >= @prevStart AND T0.CloseDate < @start THEN 1 ELSE 0 END) AS ClosedOrders
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @prevStart AND T0.DueDate < @start AND T0.Status <> 'C';

        SELECT
          T0.DocNum AS ProductionOrderNo,
          T0.ProdName AS ProductName,
          T0.PlannedQty,
          T0.CmpltQty AS CompletedQty,
          ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) AS RemainingQty,
          T0.DueDate,
          CASE T0.Status WHEN 'P' THEN 'Planned' WHEN 'R' THEN 'Released' ELSE T0.Status END AS StatusName,
          DATEDIFF(DAY, T0.DueDate, @today) AS DaysOverdue
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @start AND T0.DueDate < @end
          AND T0.DueDate < @today
          AND T0.Status IN ('R', 'P')
          AND ISNULL(T0.CmpltQty, 0) < ISNULL(T0.PlannedQty, 0)
        ORDER BY T0.DueDate, T0.DocNum;

        SELECT
          YEAR(T0.DueDate) AS ReportYear,
          MONTH(T0.DueDate) AS ReportMonth,
          SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
          SUM(ISNULL(T0.CmpltQty, 0)) AS CompletedQty,
          SUM(CASE WHEN T0.Status = 'R' AND ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS InProcessQty
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @trendStart AND T0.DueDate < @end AND T0.Status <> 'C'
        GROUP BY YEAR(T0.DueDate), MONTH(T0.DueDate)
        ORDER BY YEAR(T0.DueDate), MONTH(T0.DueDate);

        SELECT
          T0.ItemCode,
          T0.ProdName AS ProductName,
          SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
          SUM(ISNULL(T0.CmpltQty, 0)) AS CompletedQty,
          SUM(CASE WHEN ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS RemainingQty
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.DueDate >= @start AND T0.DueDate < @end AND T0.Status <> 'C'
        GROUP BY T0.ItemCode, T0.ProdName
        ORDER BY SUM(ISNULL(T0.PlannedQty, 0)) DESC;

        SELECT
          ISNULL(G.ItmsGrpNam, 'Unassigned') AS ItemGroup,
          SUM(ISNULL(T0.PlannedQty, 0)) AS PlannedQty,
          SUM(ISNULL(T0.CmpltQty, 0)) AS CompletedQty,
          SUM(CASE WHEN ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS RemainingQty
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        LEFT JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON T0.ItemCode = I.ItemCode
        LEFT JOIN LDS_LIVE.dbo.OITB G WITH (NOLOCK) ON I.ItmsGrpCod = G.ItmsGrpCod
        WHERE T0.DueDate >= @start AND T0.DueDate < @end AND T0.Status <> 'C'
        GROUP BY G.ItmsGrpNam
        ORDER BY SUM(ISNULL(T0.PlannedQty, 0)) DESC;

        SELECT
          AVG(CAST(DATEDIFF(DAY, T0.StartDate, T0.CloseDate) AS FLOAT)) AS AverageDays,
          COUNT(*) AS ClosedOrders
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        WHERE T0.Status = 'L'
          AND T0.CloseDate >= @start AND T0.CloseDate < @end
          AND T0.StartDate IS NOT NULL
          AND T0.CloseDate >= T0.StartDate;

        SELECT b.U_status AS StatusCode, COUNT(*) AS LineCount
        FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
        INNER JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry = b.DocEntry
        WHERE a.U_SmpDate >= @start AND a.U_SmpDate < @end
          AND b.U_status IN ('S', 'UI', 'A', 'R', 'P', 'CA', 'CR', 'C')
        GROUP BY b.U_status;

        SELECT b.U_status AS StatusCode, COUNT(*) AS LineCount
        FROM DOME.dbo.[@XD_OSMP] a WITH (NOLOCK)
        INNER JOIN DOME.dbo.[@XD_SMP1] b WITH (NOLOCK) ON a.DocEntry = b.DocEntry
        WHERE a.U_SmpDate >= @prevStart AND a.U_SmpDate < @start
          AND b.U_status IN ('A', 'R', 'CA', 'CR')
        GROUP BY b.U_status;

        SELECT TOP 8
          ISNULL(G.ItmsGrpNam, 'Unassigned') AS ItemGroup,
          SUM(CASE WHEN ISNULL(T0.PlannedQty, 0) > ISNULL(T0.CmpltQty, 0)
            THEN ISNULL(T0.PlannedQty, 0) - ISNULL(T0.CmpltQty, 0) ELSE 0 END) AS RemainingQty,
          COUNT(*) AS OrderCount
        FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
        LEFT JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON T0.ItemCode = I.ItemCode
        LEFT JOIN LDS_LIVE.dbo.OITB G WITH (NOLOCK) ON I.ItmsGrpCod = G.ItmsGrpCod
        WHERE T0.DueDate >= @start AND T0.DueDate < @end
          AND T0.Status = 'R'
          AND ISNULL(T0.CmpltQty, 0) < ISNULL(T0.PlannedQty, 0)
        GROUP BY G.ItmsGrpNam
        ORDER BY RemainingQty DESC;
      `);

    const sets = result.recordsets || [];
    const current = sets[0]?.[0] || {};
    const previous = sets[1]?.[0] || {};
    const rate = (completed, planned) => {
      const plan = Number(planned) || 0;
      if (plan <= 0) return null;
      return Number(((Number(completed) || 0) / plan * 100).toFixed(1));
    };
    const num = (value) => Number(value) || 0;
    const withPct = (rows) => rows.map((row) => ({
      ...row,
      PlannedQty: num(row.PlannedQty),
      CompletedQty: num(row.CompletedQty),
      RemainingQty: num(row.RemainingQty),
      CompletionPct: rate(row.CompletedQty, row.PlannedQty),
    }));

    const qualityMap = (rows) => {
      const counts = { S: 0, UI: 0, A: 0, R: 0, P: 0, CA: 0, CR: 0, C: 0 };
      (rows || []).forEach((row) => {
        if (Object.prototype.hasOwnProperty.call(counts, row.StatusCode)) {
          counts[row.StatusCode] = num(row.LineCount);
        }
      });
      const inspected = counts.A + counts.R + counts.CA + counts.CR;
      return {
        inspected,
        accepted: counts.A,
        rejected: counts.R,
        awaiting: counts.UI,
        acceptanceRate: inspected > 0 ? Number((counts.A / inspected * 100).toFixed(1)) : null,
        rejectionRate: inspected > 0 ? Number((counts.R / inspected * 100).toFixed(1)) : null,
      };
    };

    const delayed = (sets[2] || []).map((row) => ({
      ...row,
      DueDate: formatDate(row.DueDate),
      PlannedQty: num(row.PlannedQty),
      CompletedQty: num(row.CompletedQty),
      RemainingQty: num(row.RemainingQty),
      DaysOverdue: num(row.DaysOverdue),
    }));
    const overdueQty = delayed.reduce((sum, row) => sum + row.RemainingQty, 0);
    const maxOverdue = delayed.reduce((max, row) => Math.max(max, row.DaysOverdue), 0);
    const quality = qualityMap(sets[7]);
    const previousQuality = qualityMap(sets[8]);
    const completionRate = rate(current.CompletedQty, current.PlannedQty);
    const previousCompletionRate = rate(previous.CompletedQty, previous.PlannedQty);
    const pointChange = (currentValue, previousValue) => {
      if (currentValue == null || previousValue == null) return null;
      return Number((currentValue - previousValue).toFixed(1));
    };
    const pctChange = (currentValue, previousValue) => {
      const prev = Number(previousValue) || 0;
      if (prev === 0) return null;
      return Number((((Number(currentValue) || 0) - prev) / prev * 100).toFixed(1));
    };

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    res.status(200).json({
      success: true,
      data: {
        notes: {
          cohort: "Orders with DueDate in the selected month, excluding cancelled.",
          quantities: "OWOR PlannedQty and CmpltQty. Remaining quantity is not added across item groups as a single total because units can differ.",
          delayed: "Planned or Released, due date in the selected month, due date before today, and completed quantity still below planned quantity.",
          trend: "Last 12 months by DueDate. Completed is CmpltQty currently stored on those orders.",
          quality: "One row per sample line. Inspected is Accepted, Rejected, Conditionally Accepted, and Conditionally Rejected. Acceptance and rejection rates use Accepted and Rejected only over that inspected total.",
          averageTime: "Closed orders whose CloseDate is in the selected month, from StartDate to CloseDate.",
          resource: "Not shown. WOR1 quantities are component issues, not finished-goods output.",
        },
        completion: {
          rate: completionRate,
          plannedQty: num(current.PlannedQty),
          completedQty: num(current.CompletedQty),
          remainingQty: num(current.RemainingQty),
          inProcessQty: num(current.InProcessQty),
          inProgressOrders: num(current.InProgressOrders),
          closedOrders: num(current.ClosedOrders),
        },
        delayed: {
          totalOrders: delayed.length,
          overdueQty,
          maxDaysOverdue: delayed.length ? maxOverdue : 0,
          orders: delayed,
        },
        trend: (sets[3] || []).map((row) => ({
          label: `${monthNames[Number(row.ReportMonth) - 1]} ${row.ReportYear}`,
          plannedQty: num(row.PlannedQty),
          completedQty: num(row.CompletedQty),
          inProcessQty: num(row.InProcessQty),
        })),
        byProduct: withPct(sets[4] || []),
        byItemGroup: withPct(sets[5] || []),
        averageCompletionDays: sets[6]?.[0]?.AverageDays == null ? null : Number(Number(sets[6][0].AverageDays).toFixed(1)),
        averageCompletionOrders: num(sets[6]?.[0]?.ClosedOrders),
        quality,
        bottlenecks: (sets[9] || []).map((row) => ({
          ItemGroup: row.ItemGroup,
          RemainingQty: num(row.RemainingQty),
          OrderCount: num(row.OrderCount),
        })),
        comparison: {
          completionRate: pointChange(completionRate, previousCompletionRate),
          completedQty: pctChange(current.CompletedQty, previous.CompletedQty),
          closedOrders: pctChange(current.ClosedOrders, previous.ClosedOrders),
          delayedOrders: pctChange(
            delayed.length,
            num(previous.DelayedOrders),
          ),
          acceptanceRate: pointChange(quality.acceptanceRate, previousQuality.acceptanceRate),
          rejectionRate: pointChange(quality.rejectionRate, previousQuality.rejectionRate),
        },
      },
    });
  } catch (error) {
    console.error("Error in getMonthlyProductionAnalytics:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOrderStatusSummary = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT
        CASE T0.Status
          WHEN 'P' THEN 'Planned'
          WHEN 'R' THEN 'Released'
          WHEN 'L' THEN 'Closed'
          WHEN 'C' THEN 'Cancelled'
          ELSE ISNULL(T0.Status, 'Unknown')
        END AS StatusName,
        COUNT(*) AS TotalOrders
      FROM LDS_LIVE.dbo.OWOR T0 WITH (NOLOCK)
      GROUP BY T0.Status
    `);

    const counts = { Planned: 0, Released: 0, Closed: 0, Cancelled: 0 };
    (result.recordset || []).forEach((row) => {
      counts[row.StatusName] = Number(row.TotalOrders) || 0;
    });
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

    res.status(200).json({
      success: true,
      data: {
        total,
        ...counts,
      },
    });
  } catch (error) {
    console.error("Error in getOrderStatusSummary:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.testPackSize = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT TOP 20 
        ItemCode, 
        ItemName, 
        SalPackUn, 
        NumInSale
      FROM LDS_LIVE.dbo.OITM 
      WHERE ItemName LIKE '%50%' OR ItemName LIKE '%96%' OR ItemName LIKE '%Rapid%'
    `);
    res.status(200).json({ success: true, data: result.recordset });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
