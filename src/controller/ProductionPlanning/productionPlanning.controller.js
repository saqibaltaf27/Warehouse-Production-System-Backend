const { sql, poolPromise } = require("../../database/connection");

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
    const warehouse = req.query.warehouse || '';
    const status = req.query.status || '';
    const minShortage = parseFloat(req.query.minShortage) || 0;
    
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
          ${warehouse ? `WHERE w.WhsCode = '${warehouse}'` : ''}
          GROUP BY m.ItemCode, m.ItemName
          HAVING SUM(w.OnHand) < SUM(w.IsCommited)
      )
      SELECT * FROM Shortages 
      WHERE 1=1
    `;
    
    if (search) {
      query += ` AND (ComponentCode LIKE '%${search}%' OR ComponentName LIKE '%${search}%')`;
    }
    if (status === 'zero_stock') {
      query += ` AND TotalAvailable <= 0`;
    } else if (status === 'partial_stock') {
      query += ` AND TotalAvailable > 0`;
    }
    if (minShortage > 0) {
      query += ` AND ShortageQty >= ${minShortage}`;
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
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';
    
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
    if (fromDate) {
      whereClause += ` AND b.ExpDate >= '${fromDate}'`;
    }
    if (toDate) {
      whereClause += ` AND b.ExpDate <= '${toDate}'`;
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

    const parsedPersons = result.recordset.map(plan => {
      if (!plan.Persons) return [];
      try {
        const parsed = JSON.parse(plan.Persons);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    });

    const staffIds = [...new Set(
      parsedPersons.flatMap(items => items.map(item => parseInt(item.StaffID, 10))).filter(id => Number.isInteger(id))
    )];

    const staffNameById = {};
    if (staffIds.length > 0) {
      const staffResult = await pool.request().query(
        `SELECT StaffID, Name FROM Dome.dbo.PMSStaff WHERE StaffID IN (${staffIds.join(',')})`
      );
      staffResult.recordset.forEach(staff => {
        staffNameById[staff.StaffID] = staff.Name;
      });
    }

    // Persons stores StaffID + J.D. Resolve the employee name for the labour drill-down.
    const plans = result.recordset.map((plan, index) => ({
      ...plan,
      jdItems: parsedPersons[index].map(item => ({
        ...item,
        name: item.name || staffNameById[parseInt(item.StaffID, 10)] || ''
      }))
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

const getPlannedReleasedOrders = async (req, res) => {
  try {
    const pool = await poolPromise;
    const search = String(req.query.search || "").trim();
    const request = pool.request();
    let searchClause = "";
    if (search) {
      request.input("Search", `%${search}%`);
      searchClause = `
        AND (
          T0.ProdName LIKE @Search
          OR T0.ItemCode LIKE @Search
          OR CAST(T0.DocNum AS NVARCHAR(20)) LIKE @Search
        )
      `;
    }
    const query = `
      SELECT
        T0.DocNum AS ProductionOrderNo,
        T0.ItemCode AS FGItemCode,
        T0.ProdName AS ProductName,
        T0.PostDate AS PostingDate,
        T0.DueDate AS DueDate,
        CASE T0.Status
          WHEN 'P' THEN 'Planned'
          WHEN 'R' THEN 'Released'
          WHEN 'L' THEN 'Closed'
          WHEN 'C' THEN 'Cancelled'
          ELSE T0.Status
        END AS ProductionOrderStatus,
        T0.PlannedQty AS PlannedQuantity,
        T0.CmpltQty AS CompletedQuantity,
        T0.RjctQty AS RejectedQuantity,
        T0.PlannedQty - T0.CmpltQty - T0.RjctQty AS PendingQuantity,
        T0.Warehouse AS Warehouse,
        W.WhsName AS WarehouseName
      FROM LDS_LIVE.dbo.OWOR T0
      LEFT JOIN LDS_LIVE.dbo.OWHS W ON T0.Warehouse = W.WhsCode
      WHERE T0.Status IN ('P', 'R')
      ${searchClause}
      ORDER BY T0.DueDate ASC, T0.DocNum DESC
    `;
    const result = await request.query(query);
    res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Error in getPlannedReleasedOrders:", error);
    res.status(500).json({ success: false, message: "Failed to fetch planned and released orders" });
  }
};

const toNullableNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getTodayWorkingPlans = async (req, res) => {
  try {
    const pool = await poolPromise;
    const rawDate = String(req.query.date || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().split("T")[0];
    const result = await pool.request()
      .input("PlanDate", sql.Date, date)
      .query(`
        SELECT P.Id, P.PlanDate, P.Line, P.PO, P.Shift, P.Supervisor, P.Persons
        FROM Dome.dbo.PmsProductionPlanning P
        WHERE CAST(P.PlanDate AS DATE) = @PlanDate
        ORDER BY P.Line, P.PO
      `);

    const staffIds = new Set();
    const parsed = result.recordset.map((plan) => {
      let persons = [];
      try {
        const raw = plan.Persons ? JSON.parse(plan.Persons) : [];
        if (Array.isArray(raw)) {
          persons = raw.map((person) => {
            const staffId = parseInt(person.StaffID, 10);
            if (Number.isInteger(staffId)) staffIds.add(staffId);
            return {
              StaffID: Number.isInteger(staffId) ? staffId : null,
              jd: person.jd || "",
              hours: person.hours || "",
            };
          }).filter((person) => person.StaffID);
        }
      } catch (error) {
        persons = [];
      }
      return { ...plan, persons };
    });

    const staffNameById = {};
    const ids = [...staffIds];
    if (ids.length > 0) {
      const staffResult = await pool.request().query(`
        SELECT StaffID, Name FROM Dome.dbo.PMSStaff WHERE StaffID IN (${ids.join(",")})
      `);
      staffResult.recordset.forEach((staff) => {
        staffNameById[staff.StaffID] = staff.Name;
      });
    }

    const productByPo = {};
    const poNums = [...new Set(
      parsed
        .map((plan) => Number.parseInt(plan.PO, 10))
        .filter((po) => Number.isInteger(po))
    )];
    if (poNums.length > 0) {
      try {
        const productResult = await pool.request().query(`
          SELECT DocNum AS PO, ItemCode AS FGItemCode, ProdName AS ProductName
          FROM LDS_LIVE.dbo.OWOR WITH (NOLOCK)
          WHERE DocNum IN (${poNums.join(",")})
        `);
        productResult.recordset.forEach((row) => {
          productByPo[String(row.PO)] = {
            FGItemCode: row.FGItemCode || "",
            ProductName: row.ProductName || "",
          };
        });
      } catch (productError) {
        console.error("Error loading PO product names:", productError);
      }
    }

    const blockers = [];
    try {
      const blockerResult = await pool.request().query(`
        SELECT
          O.DocNum AS PO,
          O.ProdName AS ProductName,
          W.ItemCode,
          M.ItemName,
          ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0) AS OutstandingQty,
          ISNULL(I.OnHand, 0) AS OnHand,
          (ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0)) - ISNULL(I.OnHand, 0) AS ShortageQty
        FROM LDS_LIVE.dbo.OWOR O WITH (NOLOCK)
        INNER JOIN LDS_LIVE.dbo.WOR1 W WITH (NOLOCK) ON W.DocEntry = O.DocEntry
        LEFT JOIN LDS_LIVE.dbo.OITW I WITH (NOLOCK)
          ON I.ItemCode = W.ItemCode AND I.WhsCode = W.wareHouse
        LEFT JOIN LDS_LIVE.dbo.OITM M WITH (NOLOCK) ON M.ItemCode = W.ItemCode
        WHERE O.Status IN ('P', 'R')
          AND ISNULL(W.ItemType, 4) = 4
          AND ISNULL(W.PlannedQty, 0) - ISNULL(W.IssuedQty, 0) > ISNULL(I.OnHand, 0)
        ORDER BY O.DocNum, ShortageQty DESC
      `);
      blockerResult.recordset.forEach((row) => {
        blockers.push({
          po: row.PO,
          product: row.ProductName || "",
          itemCode: row.ItemCode,
          itemName: row.ItemName || "",
          outstandingQty: toNullableNumber(row.OutstandingQty),
          onHand: toNullableNumber(row.OnHand),
          shortageQty: toNullableNumber(row.ShortageQty),
          blocker: "Material shortage",
        });
      });
    } catch (blockerError) {
      console.error("Error in production blockers:", blockerError);
    }

    const staffPoHours = {};
    const data = parsed.map((plan) => {
      const poKey = plan.PO != null ? String(plan.PO) : "";
      const staff = plan.persons.map((person) => {
        const hours = toNullableNumber(person.hours);
        if (!staffPoHours[person.StaffID]) {
          staffPoHours[person.StaffID] = { hours: 0, pos: new Set() };
        }
        staffPoHours[person.StaffID].hours += hours || 0;
        if (poKey) staffPoHours[person.StaffID].pos.add(poKey);
        return {
          StaffID: person.StaffID,
          Name: staffNameById[person.StaffID] || "",
          jd: person.jd,
          hours: person.hours,
          hoursKind: "planned",
        };
      });
      return {
        Id: plan.Id,
        PlanDate: plan.PlanDate,
        Line: plan.Line,
        PO: plan.PO,
        FGItemCode: productByPo[poKey]?.FGItemCode || "",
        ProductName: productByPo[poKey]?.ProductName || "",
        Shift: plan.Shift,
        Supervisor: plan.Supervisor,
        staff,
      };
    });

    const workingPOs = new Set(data.map((plan) => String(plan.PO || "")).filter(Boolean));
    const scheduledLines = new Set(data.map((plan) => plan.Line).filter(Boolean));
    const blockedPos = new Set(blockers.map((row) => String(row.po)));
    const overlapWarnings = Object.entries(staffPoHours)
      .filter(([, info]) => info.pos.size > 1)
      .map(([staffId, info]) => ({
        StaffID: Number(staffId),
        Name: staffNameById[Number(staffId)] || "",
        pos: [...info.pos],
        plannedHours: info.hours,
      }));

    res.json({
      success: true,
      date,
      kpis: {
        workingPOs: workingPOs.size,
        scheduledLines: scheduledLines.size,
        assignedStaff: staffIds.size,
        assignmentRecords: data.reduce((sum, plan) => sum + plan.staff.length, 0),
        blockedOrders: blockedPos.size,
      },
      overlapWarnings,
      blockers,
      data,
    });
  } catch (error) {
    console.error("Error in getTodayWorkingPlans:", error);
    res.status(500).json({ success: false, message: "Failed to fetch today's working plans" });
  }
};

const toIsoDate = (value) => {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const poStatusLabel = (status) => {
  const labels = { P: "Planned", R: "Released", L: "Closed", C: "Cancelled" };
  return labels[status] || status || "";
};

const getMonthWorkingPos = async (req, res) => {
  try {
    const pool = await poolPromise;
    const rawDate = String(req.query.date || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().split("T")[0];

    const result = await pool.request()
      .input("PlanDate", sql.Date, date)
      .query(`
        DECLARE @SelectedDate DATE = @PlanDate;
        DECLARE @StartDate DATE = DATEFROMPARTS(YEAR(@SelectedDate), MONTH(@SelectedDate), 1);
        DECLARE @EndDate DATE = DATEADD(MONTH, 1, @StartDate);

        WITH ProductionPlan AS
        (
            SELECT
                W.DocEntry,
                W.DocNum AS PO,
                CAST(W.StartDate AS DATE) AS PlanDate,
                W.ItemCode,
                W.ProdName AS ItemName,
                W.PlannedQty,
                W.CmpltQty,
                W.Status
            FROM LDS_LIVE.dbo.OWOR W
            WHERE W.StartDate >= @StartDate
              AND W.StartDate < @EndDate
        ),
        ActualProduction AS
        (
            SELECT
                R1.BaseEntry,
                CAST(R0.DocDate AS DATE) AS ActualDate,
                SUM(R1.Quantity) AS ActualQty
            FROM LDS_LIVE.dbo.OIGN R0
            INNER JOIN LDS_LIVE.dbo.IGN1 R1
                ON R0.DocEntry = R1.DocEntry
            WHERE R1.BaseType = 202
              AND R0.CANCELED = 'N'
              AND R0.DocDate >= @StartDate
              AND R0.DocDate < @EndDate
            GROUP BY
                R1.BaseEntry,
                CAST(R0.DocDate AS DATE)
        )
        SELECT
            @StartDate AS MonthStart,
            @EndDate AS MonthEnd,
            P.PlanDate,
            A.ActualDate,
            A.BaseEntry AS GrNo,
            P.PO,
            P.ItemCode,
            P.ItemName,
            P.PlannedQty AS POPlannedQty,
            ISNULL(A.ActualQty, 0) AS DailyActualQty,
            P.CmpltQty AS POCompletedQty,
            P.Status AS POStatus
        FROM ProductionPlan P
        LEFT JOIN ActualProduction A
            ON P.DocEntry = A.BaseEntry
        ORDER BY
            P.PlanDate,
            P.PO,
            A.ActualDate;
      `);

    const recordset = result.recordset || [];
    const monthStart = toIsoDate(recordset[0]?.MonthStart) || `${date.slice(0, 7)}-01`;
    const monthEnd = toIsoDate(recordset[0]?.MonthEnd);
    const rows = recordset.map((row) => ({
      startDate: toIsoDate(row.PlanDate),
      actualDate: toIsoDate(row.ActualDate),
      grNo: row.GrNo ?? "",
      PO: row.PO,
      ItemCode: row.ItemCode || "",
      ItemName: row.ItemName || "",
      plannedQty: toNullableNumber(row.POPlannedQty),
      postedProduction: toNullableNumber(row.DailyActualQty) || 0,
      completedQty: toNullableNumber(row.POCompletedQty),
      status: poStatusLabel(row.POStatus),
      statusCode: row.POStatus || "",
    }));

    const uniquePos = new Map();
    rows.forEach((row) => {
      if (!uniquePos.has(String(row.PO))) uniquePos.set(String(row.PO), row);
    });
    const postedOnDate = rows
      .filter((row) => row.actualDate === date)
      .reduce((sum, row) => sum + (row.postedProduction || 0), 0);
    const postedInMonth = rows.reduce((sum, row) => sum + (row.postedProduction || 0), 0);
    const plannedOutput = [...uniquePos.values()].reduce((sum, row) => sum + (row.plannedQty || 0), 0);

    res.json({
      success: true,
      date,
      monthStart,
      monthEnd,
      kpis: {
        workingPOs: uniquePos.size,
        plannedOutput,
        postedProduction: postedOnDate,
        postedProductionMonth: postedInMonth,
      },
      data: rows,
    });
  } catch (error) {
    console.error("Error in getMonthWorkingPos:", error);
    res.status(500).json({ success: false, message: "Failed to fetch month working POs" });
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
  getMachineEfficiency,
  getPlannedReleasedOrders,
  getTodayWorkingPlans,
  getMonthWorkingPos
};

