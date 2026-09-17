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
    // We use standard SAP B1 logic: IsCommited vs OnHand for true shortage
    // But we filter only for items that are currently needed in Released Production Orders
    let query = `
      WITH ProdComponents AS (
          SELECT DISTINCT w1.ItemCode
          FROM LDS_LIVE.dbo.WOR1 w1 (NOLOCK)
          INNER JOIN LDS_LIVE.dbo.OWOR p (NOLOCK) ON w1.DocEntry = p.DocEntry 
          WHERE p.Status = 'R' AND w1.ItemType = 4 AND (w1.PlannedQty - w1.IssuedQty) > 0
      ),
      Shortages AS (
          SELECT 
              m.ItemCode AS ComponentCode,
              m.ItemName AS ComponentName,
              ISNULL(SUM(w.IsCommited), 0) AS RemainingRequired,
              ISNULL(SUM(w.OnHand), 0) AS TotalAvailable,
              ISNULL(SUM(w.IsCommited), 0) - ISNULL(SUM(w.OnHand), 0) AS ShortageQty
          FROM LDS_LIVE.dbo.OITW w (NOLOCK)
          INNER JOIN LDS_LIVE.dbo.OITM m (NOLOCK) ON w.ItemCode = m.ItemCode
          INNER JOIN ProdComponents pc ON m.ItemCode = pc.ItemCode
          GROUP BY m.ItemCode, m.ItemName
          HAVING SUM(w.OnHand) < SUM(w.IsCommited)
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

const getOpenProductionOrders = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `SELECT DocNum FROM LDS_LIVE.dbo.OWOR WHERE Status IN ('R','L') ORDER BY DocNum DESC`;
    const result = await pool.request().query(query);
    
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error in getOpenProductionOrders:", error);
    res.status(500).json({ success: false, message: "Failed to fetch open production orders" });
  }
};

const getProductionPlans = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT 
        p.Id, p.PlanDate, p.Line, p.Machine, p.Supervisor, p.PO, p.Persons, p.CreatedAt,
        p.Shift, p.PlannedManpower, p.ActualManpower, p.WorkingHours, p.ProductionQty, 
        p.TotalManHour, p.UnitsPerManHour, p.StdUnitsPerManHour, p.PrdPercentage, p.Remarks,
        ISNULL(o.PlannedQty, 0) AS PlannedQty,
        ISNULL(o.CmpltQty, 0) AS CmpltQty
      FROM Dome.dbo.PmsProductionPlanning p
      LEFT JOIN LDS_LIVE.dbo.OWOR o ON p.PO = CAST(o.DocNum AS NVARCHAR(100))
      ORDER BY p.CreatedAt DESC
    `;
    const result = await pool.request().query(query);
    
    // Parse Persons JSON for the frontend
    const plans = result.recordset.map(plan => ({
      ...plan,
      jdItems: plan.Persons ? JSON.parse(plan.Persons) : []
    }));

    res.json({
      success: true,
      data: plans
    });
  } catch (error) {
    console.error("Error in getProductionPlans:", error);
    res.status(500).json({ success: false, message: "Failed to fetch production plans" });
  }
};

const createProductionPlan = async (req, res) => {
  try {
    const { 
      date, line, machineItems, supervisor, po, jdItems,
      shift, plannedManpower, actualManpower, workingHours,
      productionQty, totalManHour, unitsPerManHour,
      stdUnitsPerManHour, prdPercentage, remarks
    } = req.body;
    
    if (!date || !line) {
      return res.status(400).json({ success: false, message: "Date and Line are required" });
    }

    const pool = await poolPromise;
    const personsJson = JSON.stringify(jdItems || []);
    // Ensure we handle backwards compatibility if old `machine` string comes through, but we prefer `machineItems` array
    const machineJson = req.body.machine ? req.body.machine : JSON.stringify(machineItems || []);

    const insertQuery = `
      BEGIN TRAN;
      DECLARE @NextId INT;
      SELECT @NextId = ISNULL(MAX(Id), 0) + 1 FROM Dome.dbo.PmsProductionPlanning WITH (UPDLOCK, ROWLOCK);
      
      INSERT INTO Dome.dbo.PmsProductionPlanning (
        Id, PlanDate, Line, Machine, Supervisor, PO, Persons, CreatedAt,
        Shift, PlannedManpower, ActualManpower, WorkingHours, ProductionQty, TotalManHour, UnitsPerManHour, StdUnitsPerManHour, PrdPercentage, Remarks
      )
      VALUES (
        @NextId, @PlanDate, @Line, @Machine, @Supervisor, @PO, @Persons, GETDATE(),
        @Shift, @PlannedManpower, @ActualManpower, @WorkingHours, @ProductionQty, @TotalManHour, @UnitsPerManHour, @StdUnitsPerManHour, @PrdPercentage, @Remarks
      );
      
      SELECT @NextId AS NextId;
      COMMIT TRAN;
    `;

    const result = await pool.request()
      .input('PlanDate', date)
      .input('Line', line)
      .input('Machine', machineJson)
      .input('Supervisor', supervisor || null)
      .input('PO', po || null)
      .input('Persons', personsJson)
      .input('Shift', shift || null)
      .input('PlannedManpower', plannedManpower || null)
      .input('ActualManpower', actualManpower || null)
      .input('WorkingHours', workingHours || null)
      .input('ProductionQty', productionQty || null)
      .input('TotalManHour', totalManHour || null)
      .input('UnitsPerManHour', unitsPerManHour || null)
      .input('StdUnitsPerManHour', stdUnitsPerManHour || null)
      .input('PrdPercentage', prdPercentage || null)
      .input('Remarks', remarks || null)
      .query(insertQuery);

    const nextId = result.recordset[0].NextId;

    res.json({
      success: true,
      message: "Plan created successfully",
      data: { id: nextId }
    });
  } catch (error) {
    console.error("Error in createProductionPlan:", error);
    res.status(500).json({ success: false, message: "Failed to create production plan" });
  }
};

const updateProductionPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      date, line, machineItems, supervisor, po, jdItems,
      shift, plannedManpower, actualManpower, workingHours,
      productionQty, totalManHour, unitsPerManHour,
      stdUnitsPerManHour, prdPercentage, remarks
    } = req.body;
    
    if (!id || !date || !line) {
      return res.status(400).json({ success: false, message: "ID, Date and Line are required" });
    }

    const pool = await poolPromise;
    const personsJson = JSON.stringify(jdItems || []);
    const machineJson = req.body.machine ? req.body.machine : JSON.stringify(machineItems || []);

    const updateQuery = `
      UPDATE Dome.dbo.PmsProductionPlanning
      SET PlanDate = @PlanDate,
          Line = @Line,
          Machine = @Machine,
          Supervisor = @Supervisor,
          PO = @PO,
          Persons = @Persons,
          Shift = @Shift,
          PlannedManpower = @PlannedManpower,
          ActualManpower = @ActualManpower,
          WorkingHours = @WorkingHours,
          ProductionQty = @ProductionQty,
          TotalManHour = @TotalManHour,
          UnitsPerManHour = @UnitsPerManHour,
          StdUnitsPerManHour = @StdUnitsPerManHour,
          PrdPercentage = @PrdPercentage,
          Remarks = @Remarks
      WHERE Id = @Id
    `;

    await pool.request()
      .input('Id', id)
      .input('PlanDate', date)
      .input('Line', line)
      .input('Machine', machineJson)
      .input('Supervisor', supervisor || null)
      .input('PO', po || null)
      .input('Persons', personsJson)
      .input('Shift', shift || null)
      .input('PlannedManpower', plannedManpower || null)
      .input('ActualManpower', actualManpower || null)
      .input('WorkingHours', workingHours || null)
      .input('ProductionQty', productionQty || null)
      .input('TotalManHour', totalManHour || null)
      .input('UnitsPerManHour', unitsPerManHour || null)
      .input('StdUnitsPerManHour', stdUnitsPerManHour || null)
      .input('PrdPercentage', prdPercentage || null)
      .input('Remarks', remarks || null)
      .query(updateQuery);

    res.json({
      success: true,
      message: "Plan updated successfully"
    });
  } catch (error) {
    console.error("Error in updateProductionPlan:", error);
    res.status(500).json({ success: false, message: "Failed to update production plan" });
  }
};

const getMachines = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT ItemCode, ItemName 
      FROM LDS_LIVE.dbo.OITM 
      WHERE itmsGrpCod = '100' 
      AND U_cat1 IN ('Equipments', 'Finished Product')
      ORDER BY ItemName ASC
    `;
    const result = await pool.request().query(query);
    
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error in getMachines:", error);
    res.status(500).json({ success: false, message: "Failed to fetch machines" });
  }
};

const getManEfficiency = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT Id, Name, ProductionLine, Hour, Qty, CreatedDate, CreatedBy 
      FROM Dome.dbo.PMSManEfficiency 
      ORDER BY CreatedDate DESC
    `;
    const result = await pool.request().query(query);
    
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error in getManEfficiency:", error);
    res.status(500).json({ success: false, message: "Failed to fetch man efficiency records" });
  }
};

const createManEfficiency = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { name, productionLine, hours, qty, createdBy } = req.body;

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      const idQuery = `SELECT ISNULL(MAX(Id), 0) + 1 AS NextId FROM Dome.dbo.PMSManEfficiency WITH (UPDLOCK, HOLDLOCK)`;
      const idResult = await transaction.request().query(idQuery);
      const nextId = idResult.recordset[0].NextId;

      const insertQuery = `
        INSERT INTO Dome.dbo.PMSManEfficiency (Id, Name, ProductionLine, Hour, Qty, CreatedBy)
        VALUES (@Id, @Name, @ProductionLine, @Hour, @Qty, @CreatedBy)
      `;
      
      await transaction.request()
        .input('Id', nextId)
        .input('Name', name)
        .input('ProductionLine', productionLine)
        .input('Hour', hours)
        .input('Qty', qty)
        .input('CreatedBy', createdBy || null)
        .query(insertQuery);

      await transaction.commit();

      res.json({
        success: true,
        message: "Man efficiency created successfully"
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    console.error("Error in createManEfficiency:", error);
    res.status(500).json({ success: false, message: "Failed to create man efficiency record" });
  }
};

const getMachineEfficiency = async (req, res) => {
  try {
    const pool = await poolPromise;
    const query = `
      SELECT Id, ItemCode, Machine, TotalHours, TotalQuantityProduced, CreatedDate, CreatedBy 
      FROM Dome.dbo.PMSMachineEfficiency 
      ORDER BY CreatedDate DESC
    `;
    const result = await pool.request().query(query);
    
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("Error in getMachineEfficiency:", error);
    res.status(500).json({ success: false, message: "Failed to fetch machine efficiency records" });
  }
};

const createMachineEfficiency = async (req, res) => {
  try {
    const pool = await poolPromise;
    const { itemCode, machine, totalHours, totalQuantityProduced, createdBy } = req.body;

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      const idQuery = `SELECT ISNULL(MAX(Id), 0) + 1 AS NextId FROM Dome.dbo.PMSMachineEfficiency WITH (UPDLOCK, HOLDLOCK)`;
      const idResult = await transaction.request().query(idQuery);
      const nextId = idResult.recordset[0].NextId;

      const insertQuery = `
        INSERT INTO Dome.dbo.PMSMachineEfficiency (Id, ItemCode, Machine, TotalHours, TotalQuantityProduced, CreatedBy)
        VALUES (@Id, @ItemCode, @Machine, @TotalHours, @TotalQuantityProduced, @CreatedBy)
      `;
      
      await transaction.request()
        .input('Id', nextId)
        .input('ItemCode', itemCode)
        .input('Machine', machine)
        .input('TotalHours', totalHours)
        .input('TotalQuantityProduced', totalQuantityProduced)
        .input('CreatedBy', createdBy || null)
        .query(insertQuery);

      await transaction.commit();

      res.json({
        success: true,
        message: "Machine efficiency created successfully"
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    console.error("Error in createMachineEfficiency:", error);
    res.status(500).json({ success: false, message: "Failed to create machine efficiency record" });
  }
};

module.exports = {
  getExecutiveKPIs,
  getMaterialShortages,
  getBatchExpiry,
  getOpenProductionOrders,
  getProductionPlans,
  createProductionPlan,
  updateProductionPlan,
  getMachines,
  createManEfficiency,
  getManEfficiency,
  createMachineEfficiency,
  getMachineEfficiency
};

