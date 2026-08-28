const { poolPromise } = require("../../database/connection");

const safeInt = (val, defaultVal) => {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultVal : parsed;
};

const getExecutiveKPIs = async (req, res) => {
  try {
    const pool = await poolPromise;
    const page = safeInt(req.query.page, 1);
    const pageSize = safeInt(req.query.pageSize, 20);
    const offset = (page - 1) * pageSize;
    
    // Filters
    const search = req.query.search || '';
    const status = req.query.status || '';
    const warehouse = req.query.warehouse || '';
    
    let whereClause = "p.Status IN ('P', 'R')";
    
    if (status) {
      whereClause += ` AND p.Status = '${status}'`;
    }
    if (warehouse) {
      whereClause += ` AND p.Warehouse = '${warehouse}'`;
    }
    if (search) {
      whereClause += ` AND (CAST(p.DocNum AS VARCHAR) LIKE '%${search}%' OR i.ItemName LIKE '%${search}%' OR p.ItemCode LIKE '%${search}%')`;
    }

    // 1. Get KPIs (Total Aggregations without Pagination)
    const kpiQuery = `
      SELECT 
          COUNT(*) as TotalOpen,
          SUM(CASE WHEN p.DueDate < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as DelayedOrders,
          SUM(p.PlannedQty) as TotalPlanned,
          SUM(p.CmpltQty) as TotalProduced
      FROM LDS_Live.dbo.OWOR p (NOLOCK)
      LEFT JOIN LDS_Live.dbo.OITM i (NOLOCK) ON p.ItemCode = i.ItemCode
      WHERE ${whereClause}
    `;
    const kpiRes = await pool.request().query(kpiQuery);
    const kpiRecord = kpiRes.recordset[0];
    
    const totalOpen = kpiRecord.TotalOpen || 0;
    const delayedOrders = kpiRecord.DelayedOrders || 0;
    const totalPlanned = kpiRecord.TotalPlanned || 0;
    const totalProduced = kpiRecord.TotalProduced || 0;
    const completionPct = totalPlanned > 0 ? ((totalProduced / totalPlanned) * 100).toFixed(1) : 0;

    // 2. Get Paginated Orders
    const dataQuery = `
      SELECT 
          p.DocNum AS ProductionOrder,
          p.ItemCode AS FinishedGoodCode,
          i.ItemName AS FinishedGoodName,
          p.Status,
          p.PlannedQty,
          p.CmpltQty AS ProducedQty,
          (p.PlannedQty - p.CmpltQty) AS RemainingQty,
          CASE WHEN p.PlannedQty > 0 THEN (p.CmpltQty / p.PlannedQty) * 100 ELSE 0 END AS CompletionPct,
          CAST(p.StartDate AS DATE) AS StartDate,
          CAST(p.DueDate AS DATE) AS DueDate,
          CASE 
              WHEN p.DueDate < CAST(GETDATE() AS DATE) THEN DATEDIFF(day, p.DueDate, GETDATE()) 
              ELSE 0 
          END AS DaysDelayed,
          p.Warehouse
      FROM LDS_Live.dbo.OWOR p (NOLOCK)
      LEFT JOIN LDS_Live.dbo.OITM i (NOLOCK) ON p.ItemCode = i.ItemCode
      WHERE ${whereClause}
      ORDER BY p.DueDate ASC
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `;
    const dataRes = await pool.request().query(dataQuery);
    
    res.json({
      success: true,
      data: {
        kpis: {
          totalOpen,
          delayedOrders,
          completionPct
        },
        orders: dataRes.recordset
      },
      pagination: {
        totalRecords: totalOpen,
        currentPage: page,
        pageSize,
        totalPages: Math.ceil(totalOpen / pageSize)
      }
    });
  } catch (error) {
    console.error("Error in getExecutiveKPIs:", error);
    res.status(500).json({ success: false, message: "Failed to fetch KPIs" });
  }
};

const getMaterialShortages = async (req, res) => {
  try {
    const pool = await poolPromise;
    const page = safeInt(req.query.page, 1);
    const pageSize = safeInt(req.query.pageSize, 20);
    const offset = (page - 1) * pageSize;
    
    const search = req.query.search || '';
    
    // Dataset 2: Material Shortages for Open Orders
    let query = `
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
          SELECT 
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
      )
      SELECT * FROM Shortages 
      WHERE 1=1
    `;
    
    if (search) {
      query += ` AND (ComponentCode LIKE '%${search}%' OR ComponentName LIKE '%${search}%')`;
    }
    
    // Get total count
    const countQuery = query.replace('SELECT * FROM Shortages', 'SELECT COUNT(*) as count FROM Shortages');
    const countRes = await pool.request().query(countQuery);
    const totalRecords = countRes.recordset[0].count;
    
    // Get paginated data
    query += ` ORDER BY ShortageQty DESC OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
    const dataRes = await pool.request().query(query);
    
    res.json({
      success: true,
      data: dataRes.recordset,
      pagination: {
        totalRecords,
        currentPage: page,
        pageSize,
        totalPages: Math.ceil(totalRecords / pageSize)
      }
    });
  } catch (error) {
    console.error("Error in getMaterialShortages:", error);
    res.status(500).json({ success: false, message: "Failed to fetch shortages" });
  }
};

const getBatchExpiry = async (req, res) => {
  try {
    const pool = await poolPromise;
    const page = safeInt(req.query.page, 1);
    const pageSize = safeInt(req.query.pageSize, 20);
    const offset = (page - 1) * pageSize;
    
    const search = req.query.search || '';
    const warehouse = req.query.warehouse || '';
    const bucket = req.query.bucket || '';
    
    let whereClause = "q.Quantity > 0 AND b.ExpDate IS NOT NULL";
    if (search) {
      whereClause += ` AND (b.ItemCode LIKE '%${search}%' OR i.ItemName LIKE '%${search}%' OR b.DistNumber LIKE '%${search}%')`;
    }
    if (warehouse) {
      whereClause += ` AND q.WhsCode = '${warehouse}'`;
    }
    if (bucket === 'Expired') {
      whereClause += ` AND b.ExpDate < CAST(GETDATE() AS DATE)`;
    } else if (bucket === '0-30 Days') {
      whereClause += ` AND b.ExpDate >= CAST(GETDATE() AS DATE) AND b.ExpDate <= DATEADD(day, 30, CAST(GETDATE() AS DATE))`;
    } else if (bucket === '31-90 Days') {
      whereClause += ` AND b.ExpDate > DATEADD(day, 30, CAST(GETDATE() AS DATE)) AND b.ExpDate <= DATEADD(day, 90, CAST(GETDATE() AS DATE))`;
    } else if (bucket === '90+ Days') {
      whereClause += ` AND b.ExpDate > DATEADD(day, 90, CAST(GETDATE() AS DATE))`;
    }

    // Total Count
    const countQuery = `
      SELECT COUNT(*) as count
      FROM LDS_Live.dbo.OBTN b (NOLOCK)
      INNER JOIN LDS_Live.dbo.OBTQ q (NOLOCK) ON b.ItemCode = q.ItemCode AND b.SysNumber = q.SysNumber
      LEFT JOIN LDS_Live.dbo.OITM i (NOLOCK) ON b.ItemCode = i.ItemCode
      WHERE ${whereClause}
    `;
    const countRes = await pool.request().query(countQuery);
    const totalRecords = countRes.recordset[0].count;
    
    // Paginated Data
    const dataQuery = `
      SELECT 
          b.ItemCode,
          i.ItemName,
          b.DistNumber AS BatchNumber,
          q.WhsCode,
          q.Quantity,
          CAST(b.ExpDate AS DATE) AS ExpiryDate,
          CASE 
              WHEN b.ExpDate < GETDATE() THEN '1. Expired'
              WHEN b.ExpDate <= DATEADD(day, 30, GETDATE()) THEN '2. 0-30 Days'
              WHEN b.ExpDate <= DATEADD(day, 90, GETDATE()) THEN '3. 31-90 Days'
              ELSE '4. 90+ Days'
          END AS ExpiryBucket
      FROM LDS_Live.dbo.OBTN b (NOLOCK)
      INNER JOIN LDS_Live.dbo.OBTQ q (NOLOCK) ON b.ItemCode = q.ItemCode AND b.SysNumber = q.SysNumber
      LEFT JOIN LDS_Live.dbo.OITM i (NOLOCK) ON b.ItemCode = i.ItemCode
      WHERE ${whereClause}
      ORDER BY b.ExpDate ASC
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `;
    const dataRes = await pool.request().query(dataQuery);
    
    res.json({
      success: true,
      data: dataRes.recordset,
      pagination: {
        totalRecords,
        currentPage: page,
        pageSize,
        totalPages: Math.ceil(totalRecords / pageSize)
      }
    });
  } catch (error) {
    console.error("Error in getBatchExpiry:", error);
    res.status(500).json({ success: false, message: "Failed to fetch batch expiry" });
  }
};

const getManpowerProductivity = async (req, res) => {
  try {
    const pool = await poolPromise;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

    const countQuery = `SELECT COUNT(*) as count FROM dome.dbo.PrdManPower`;
    const countResult = await pool.request().query(countQuery);
    const totalRecords = countResult.recordset[0].count;

    const query = `
      SELECT 
        Id,
        [Date],
        [Shift],
        PlannedManpower,
        ActualManpower,
        WorkingHours,
        TotalManHour,
        ProductionQty,
        UnitsPerManHour,
        StdUnitsPerManHour,
        PrdPercentage,
        Remarks,
        CreateDate,
        CreatedBy
      FROM dome.dbo.PrdManPower
      ORDER BY [Date] DESC, Id DESC
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `;
    const result = await pool.request().query(query);
    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        totalRecords,
        currentPage: page,
        pageSize,
        totalPages: Math.ceil(totalRecords / pageSize)
      }
    });
  } catch (error) {
    console.error("Error in getManpowerProductivity:", error);
    res.status(500).json({ success: false, message: "Failed to fetch manpower productivity" });
  }
};

const addManpowerProductivity = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { 
      date, shift, plannedManpower, actualManpower, workingHours, 
      totalManHour, productionQty, unitsPerManHour, stdUnitsPerManHour, 
      prdPercentage, remarks, createdBy 
    } = req.body;
    
    const query = `
      BEGIN TRANSACTION;
      DECLARE @NewId INT;
      SELECT @NewId = ISNULL(MAX(Id), 0) + 1 FROM dome.dbo.PrdManPower WITH (UPDLOCK, SERIALIZABLE);
      
      INSERT INTO dome.dbo.PrdManPower 
      (Id, [Date], [Shift], PlannedManpower, ActualManpower, WorkingHours, TotalManHour, ProductionQty, UnitsPerManHour, StdUnitsPerManHour, PrdPercentage, Remarks, CreatedBy)
      VALUES 
      (@NewId, @Date, @Shift, @PlannedManpower, @ActualManpower, @WorkingHours, @TotalManHour, @ProductionQty, @UnitsPerManHour, @StdUnitsPerManHour, @PrdPercentage, @Remarks, @CreatedBy);
      
      COMMIT TRANSACTION;
      SELECT @NewId AS InsertedId;
    `;
    
    const request = pool.request();
    request.input('Date', date);
    request.input('Shift', shift);
    request.input('PlannedManpower', plannedManpower || null);
    request.input('ActualManpower', actualManpower || null);
    request.input('WorkingHours', workingHours || null);
    request.input('TotalManHour', totalManHour || null);
    request.input('ProductionQty', productionQty || null);
    request.input('UnitsPerManHour', unitsPerManHour || null);
    request.input('StdUnitsPerManHour', stdUnitsPerManHour || null);
    request.input('PrdPercentage', prdPercentage || null);
    request.input('Remarks', remarks || null);
    request.input('CreatedBy', createdBy || null);
    
    const result = await request.query(query);
    res.json({ success: true, message: 'Manpower productivity added', id: result.recordset[0].InsertedId });
  } catch (error) {
    console.error("Error in addManpowerProductivity:", error);
    res.status(500).json({ success: false, message: "Failed to add manpower productivity" });
  }
};

module.exports = {
  getExecutiveKPIs,
  getMaterialShortages,
  getBatchExpiry,
  getManpowerProductivity,
  addManpowerProductivity
};
