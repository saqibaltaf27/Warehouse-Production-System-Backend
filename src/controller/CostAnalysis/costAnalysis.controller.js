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
      WITH ItemCost AS (
        SELECT P.DocEntry,
               CAST(ISNULL(-SUM(CASE WHEN N.OutQty > 0 THEN N.TransValue ELSE 0 END), 0) as DECIMAL(19,3)) as ActualItemComponentCost
        FROM LDS_LIVE.dbo.OWOR P
        LEFT JOIN LDS_LIVE.dbo.OINM N ON N.AppObjAbs = P.DocEntry AND N.ApplObj = 202 AND N.OutQty > 0
        GROUP BY P.DocEntry
      ),
      ResourceCost AS (
        SELECT P.DocEntry,
               CAST(ISNULL(SUM(R.Total), 0) as DECIMAL(19,3)) as ActualResourceComponentCost
        FROM LDS_LIVE.dbo.OWOR P
        LEFT JOIN LDS_LIVE.dbo.IGE1 I ON I.BaseEntry = P.DocEntry AND I.BaseType = 202
        LEFT JOIN LDS_LIVE.dbo.IGE22 R ON R.DocEntry = I.DocEntry AND R.LineNum = I.LineNum
        GROUP BY P.DocEntry
      ),
      AdditionalCost AS (
        SELECT P.DocEntry,
               CAST(ISNULL(SUM(I.LineTotal), 0) as DECIMAL(19,3)) as ActualAdditionalCost
        FROM LDS_LIVE.dbo.OWOR P
        INNER JOIN LDS_LIVE.dbo.IGE1 I ON I.BaseEntry = P.DocEntry AND I.BaseType = 202
        LEFT JOIN LDS_LIVE.dbo.OITM M ON M.ItemCode = I.ItemCode
        WHERE ISNULL(M.InvntItem, 'Y') = 'N'
        GROUP BY P.DocEntry
      ),
      ProductCost AS (
        SELECT P.DocEntry,
               CAST(ISNULL(SUM(G.StockPrice * G.Quantity), 0) as DECIMAL(19,3)) as ActualProductCost,
               SUM(G.Quantity) as FGQty
        FROM LDS_LIVE.dbo.OWOR P
        INNER JOIN LDS_LIVE.dbo.IGN1 G ON G.BaseEntry = P.DocEntry AND G.BaseType = 202 AND G.ItemCode = P.ItemCode
        GROUP BY P.DocEntry
      ),
      PlannedCosts AS (
        SELECT 
          w.DocEntry,
          SUM(w.PlannedQty * ISNULL(CASE WHEN w.ItemType = 290 THEN r.StdCost1 ELSE ISNULL(Mat.UnitCost, 0) END, 0)) as PlannedCost
        FROM LDS_LIVE.dbo.WOR1 w
        LEFT JOIN LDS_LIVE.dbo.ORSC r ON w.ItemCode = r.ResCode AND w.ItemType = 290
        OUTER APPLY (
          SELECT TOP 1 CASE WHEN T0.InQty > 0 THEN T0.TransValue / T0.InQty ELSE 0 END AS UnitCost
          FROM LDS_LIVE.dbo.OINM T0
          WHERE T0.ItemCode = w.ItemCode AND T0.InQty > 0 AND w.ItemType <> 290
          ORDER BY T0.DocDate DESC, T0.TransSeq DESC
        ) as Mat
        GROUP BY w.DocEntry
      )
      SELECT
        o.DocEntry,
        o.DocNum,
        o.ItemCode as FGItemCode,
        o.ProdName as FGItemName,
        o.Status,
        o.PostDate,
        o.Warehouse,
        o.PlannedQty as PlannedFGQty,
        ISNULL(f.FGQty, 0) as ActualFGQty,
        (CASE WHEN o.PlannedQty > 0 THEN (ISNULL(f.FGQty, 0) / o.PlannedQty) * 100 ELSE 0 END) as YieldPercent,
        ISNULL(p.PlannedCost, 0) as PlannedCost,
        
        (ISNULL(ic.ActualItemComponentCost, 0) + ISNULL(rc.ActualResourceComponentCost, 0) + ISNULL(ac.ActualAdditionalCost, 0)) as ActualCost,
        ISNULL(ic.ActualItemComponentCost, 0) as ActualMaterialCost,
        ISNULL(rc.ActualResourceComponentCost, 0) as ActualLabourCost,
        ISNULL(ac.ActualAdditionalCost, 0) as ActualFOHCost,
        ISNULL(f.ActualProductCost, 0) as ActualProductCost,
        
        ((ISNULL(ic.ActualItemComponentCost, 0) + ISNULL(rc.ActualResourceComponentCost, 0) + ISNULL(ac.ActualAdditionalCost, 0)) - ISNULL(p.PlannedCost, 0)) as TotalVariance
      FROM LDS_LIVE.dbo.OWOR o
      LEFT JOIN PlannedCosts p ON o.DocEntry = p.DocEntry
      LEFT JOIN ItemCost ic ON o.DocEntry = ic.DocEntry
      LEFT JOIN ResourceCost rc ON o.DocEntry = rc.DocEntry
      LEFT JOIN AdditionalCost ac ON o.DocEntry = ac.DocEntry
      LEFT JOIN ProductCost f ON o.DocEntry = f.DocEntry
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
      SELECT
          P.DocNum AS [Production Order],
          CASE
              WHEN W.ItemType = 290 THEN 'Resource'
              ELSE 'Item'
          END AS [Type],
          W.ItemCode,
          ISNULL(M.ItemName, R.ResName) AS [Item Description],
          W.PlannedQty,
          CAST(
              CASE
                  WHEN W.ItemType <> 290 THEN 
                      ISNULL((
                          SELECT TOP 1 (ABS(N.TransValue) / NULLIF(I.Quantity, 0))
                          FROM LDS_LIVE.dbo.IGE1 I
                          INNER JOIN LDS_LIVE.dbo.OIGE G ON G.DocEntry = I.DocEntry
                          INNER JOIN LDS_LIVE.dbo.OINM N ON N.TransType = 60 AND N.CreatedBy = G.DocEntry AND N.DocLineNum = I.LineNum AND N.ItemCode = I.ItemCode
                          WHERE I.BaseEntry = P.DocEntry AND I.BaseType = 202 AND I.ItemCode = W.ItemCode
                      ), ISNULL(Mat.UnitCost, 0))
                  ELSE 
                      ISNULL((
                          SELECT TOP 1 I.Price
                          FROM LDS_LIVE.dbo.IGE1 I
                          WHERE I.BaseEntry = P.DocEntry AND I.BaseType = 202 AND I.ItemCode = W.ItemCode
                      ), R.StdCost1)
              END
              AS DECIMAL(19,6)
          ) AS [Item Cost]
      FROM LDS_LIVE.dbo.OWOR P
      INNER JOIN LDS_LIVE.dbo.WOR1 W ON P.DocEntry = W.DocEntry
      LEFT JOIN LDS_LIVE.dbo.OITM M ON W.ItemCode = M.ItemCode AND W.ItemType <> 290
      LEFT JOIN LDS_LIVE.dbo.ORSC R ON W.ItemCode = R.ResCode AND W.ItemType = 290
      OUTER APPLY (
          SELECT TOP 1 CASE WHEN T0.InQty > 0 THEN ABS(T0.TransValue) / T0.InQty ELSE 0 END AS UnitCost
          FROM LDS_LIVE.dbo.OINM T0
          WHERE T0.ItemCode = W.ItemCode AND T0.InQty > 0 AND W.ItemType <> 290
          ORDER BY T0.DocDate DESC, T0.TransSeq DESC
      ) as Mat
      WHERE P.DocEntry = @docEntry
    `;
    
    const request = pool.request();
    request.input('docEntry', sql.Int, docEntry);
    
    const result = await request.query(query);

    // Fetch staff and machines for this PO
    let staffDetails = [];
    let machineDetails = [];
    try {
      const docNumQuery = await pool.request()
        .input('docEntry', sql.Int, docEntry)
        .query("SELECT DocNum FROM LDS_LIVE.dbo.OWOR WHERE DocEntry = @docEntry");
      
      if (docNumQuery.recordset.length > 0) {
        const docNum = docNumQuery.recordset[0].DocNum;
        
        const planningQuery = await pool.request()
          .input('docNum', sql.VarChar, String(docNum))
          .query("SELECT PlanDate, Persons, Machine FROM Dome.dbo.PmsProductionPlanning WHERE PO = @docNum");

        let staffAgg = {}; // { StaffID: { totalHours: 0, dates: Set() } }
        let machineAgg = {}; // { MachineName: { totalHours: 0 } }
        
        planningQuery.recordset.forEach(row => {
          // Process Persons
          if (row.Persons) {
            try {
              const persons = JSON.parse(row.Persons);
              if (Array.isArray(persons)) {
                persons.forEach(p => {
                  if (p.StaffID) {
                    if (!staffAgg[p.StaffID]) {
                      staffAgg[p.StaffID] = { totalHours: 0, dates: new Set() };
                    }
                    if (p.hours) {
                      staffAgg[p.StaffID].totalHours += (parseFloat(p.hours) || 0);
                    }
                    if (row.PlanDate) {
                      const dateStr = new Date(row.PlanDate).toISOString().split('T')[0];
                      staffAgg[p.StaffID].dates.add(dateStr);
                    }
                  }
                });
              }
            } catch (e) {
              console.error("Error parsing Persons JSON", e);
            }
          }
          
          // Process Machines
          if (row.Machine) {
            try {
              const machines = JSON.parse(row.Machine);
              if (Array.isArray(machines)) {
                machines.forEach(m => {
                  if (m.name) {
                    if (!machineAgg[m.name]) {
                      machineAgg[m.name] = { totalHours: 0 };
                    }
                    if (m.hours) {
                      machineAgg[m.name].totalHours += (parseFloat(m.hours) || 0);
                    }
                  }
                });
              }
            } catch (e) {
              console.error("Error parsing Machine JSON", e);
            }
          }
        });

        // Map aggregated machines to array
        machineDetails = Object.keys(machineAgg).map(name => ({
          Name: name,
          TotalHours: machineAgg[name].totalHours
        }));

        const staffIds = Object.keys(staffAgg);
        if (staffIds.length > 0) {
          const idsString = staffIds.join(',');
          const detailsQuery = await pool.request()
            .query(`SELECT StaffID, Name, Designation, WageSalary FROM Dome.dbo.PMSStaff WHERE StaffID IN (${idsString})`);
          
          staffDetails = detailsQuery.recordset.map(s => {
            const agg = staffAgg[s.StaffID];
            const totalHours = agg ? agg.totalHours : 0;
            const daysWorked = agg ? agg.dates.size : 0;
            let cost = 0;
            if (totalHours > 0) {
              cost = ((parseFloat(s.WageSalary) || 0) / 8) * totalHours;
            }
            return {
              ...s,
              TotalHours: totalHours,
              DaysWorked: daysWorked,
              CalculatedCost: cost
            };
          });
        }
      }
    } catch (planningError) {
      console.error("Error fetching planning details for PO:", planningError);
    }

    res.status(200).json({ success: true, data: result.recordset, staff: staffDetails, machines: machineDetails });
  } catch (error) {
    console.error("Error in getOrderMaterials:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOrderStatuses = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT DISTINCT Status 
      FROM LDS_LIVE.dbo.OWOR
      WHERE Status IS NOT NULL
    `;
    const result = await pool.request().query(query);
    const statuses = result.recordset.map(r => r.Status);
    res.status(200).json({ success: true, data: statuses });
  } catch (error) {
    console.error("Error in getOrderStatuses:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
