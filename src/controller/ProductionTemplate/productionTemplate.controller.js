const ProductionTemplateModel = require('./productionTemplate.model');
const { poolPromise } = require("../../database/connection");

class ProductionTemplateController {
  static async getProductionOrders(req, res) {
    try {
      const orders = await ProductionTemplateModel.getProductionOrders();
      return res.status(200).json({
        success: true,
        data: orders
      });
    } catch (error) {
      console.error("Error fetching production orders:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error"
      });
    }
  }

  static async getManpowerProductivity(req, res) {
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
  }

  static async addManpowerProductivity(req, res) {
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
  }

  static async getDailyEfficiency(req, res) {
    try {
      const pool = await poolPromise;
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 10;
      const offset = (page - 1) * pageSize;

      const countQuery = `SELECT COUNT(*) as count FROM Dome.dbo.PrdDailyProductionEfficiency`;
      const countResult = await pool.request().query(countQuery);
      const totalRecords = countResult.recordset[0].count;

      const query = `
        SELECT 
          Id,
          ProductionDate as date,
          Shift as shift,
          LineMachine as lineMachine,
          ProductionOrder as productionOrder,
          ProductName as product,
          PlannedQty as plannedQty,
          ActualQty as actualQty,
          AchievementPercentage as achievementPct,
          StandardHours as standardHours,
          ActualHours as actualHours,
          EfficiencyPercentage as efficiencyPct,
          Manpower as manpower,
          UnitsPerManHour as unitsPerManHour,
          Remarks as remarks,
          CreatedBy as createdBy,
          CreatedDate as createdDate
        FROM Dome.dbo.PrdDailyProductionEfficiency
        ORDER BY ProductionDate DESC, Id DESC
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
      console.error("Error in getDailyEfficiency:", error);
      res.status(500).json({ success: false, message: "Failed to fetch daily efficiency" });
    }
  }

  static async addDailyEfficiency(req, res) {
    try {
      const pool = await poolPromise;
      const { 
        date, shift, lineMachine, productionOrder, product, 
        plannedQty, actualQty, achievementPct, standardHours, 
        actualHours, efficiencyPct, manpower, unitsPerManHour, 
        remarks, createdBy 
      } = req.body;
      
      const query = `
        BEGIN TRANSACTION;
        DECLARE @NewId INT;
        SELECT @NewId = ISNULL(MAX(Id), 0) + 1 FROM Dome.dbo.PrdDailyProductionEfficiency WITH (UPDLOCK, SERIALIZABLE);
        
        INSERT INTO Dome.dbo.PrdDailyProductionEfficiency 
        (Id, ProductionDate, Shift, LineMachine, ProductionOrder, ProductName, PlannedQty, ActualQty, AchievementPercentage, StandardHours, ActualHours, EfficiencyPercentage, Manpower, UnitsPerManHour, Remarks, CreatedBy, CreatedDate)
        VALUES 
        (@NewId, @Date, @Shift, @LineMachine, @ProductionOrder, @Product, @PlannedQty, @ActualQty, @AchievementPct, @StandardHours, @ActualHours, @EfficiencyPct, @Manpower, @UnitsPerManHour, @Remarks, @CreatedBy, GETDATE());
        
        COMMIT TRANSACTION;
        SELECT @NewId AS InsertedId;
      `;
      
      const request = pool.request();
      request.input('Date', date);
      request.input('Shift', shift);
      request.input('LineMachine', lineMachine);
      request.input('ProductionOrder', productionOrder);
      request.input('Product', product);
      request.input('PlannedQty', plannedQty || 0);
      request.input('ActualQty', actualQty || 0);
      request.input('AchievementPct', achievementPct || 0);
      request.input('StandardHours', standardHours || null);
      request.input('ActualHours', actualHours || 0);
      request.input('EfficiencyPct', efficiencyPct || 0);
      request.input('Manpower', manpower || 0);
      request.input('UnitsPerManHour', unitsPerManHour || 0);
      request.input('Remarks', remarks || null);
      request.input('CreatedBy', createdBy || null);
      
      const result = await request.query(query);
      res.json({ success: true, message: 'Daily efficiency added', id: result.recordset[0].InsertedId });
    } catch (error) {
      console.error("Error in addDailyEfficiency:", error);
      res.status(500).json({ success: false, message: "Failed to add daily efficiency" });
    }
  }

  static async getQualityPerformance(req, res) {
    try {
      const pool = await poolPromise;
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 10;
      const offset = (page - 1) * pageSize;

      const countQuery = `SELECT COUNT(*) as count FROM Dome.dbo.PrdQualityPerformance`;
      const countResult = await pool.request().query(countQuery);
      const totalRecords = countResult.recordset[0].count;

      const query = `
        SELECT 
          Id,
          PerformanceDate as date,
          PrdOrderId as productionOrder,
          PrdtName as product,
          PrdQty as producedQty,
          RejectedQty as rejectedQty,
          ReworkedQty as reworkedQty,
          TargetRejectionPercentage as targetRejectionPct,
          RejectionPercentage as rejectionPct,
          ReworkPercentage as reworkPct,
          FirstPassYieldPercentage as fpy,
          RejectionReason as topRejectionReason,
          CreatedBy as createdBy,
          CreatedDate as createdDate
        FROM Dome.dbo.PrdQualityPerformance
        ORDER BY PerformanceDate DESC, Id DESC
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
      console.error("Error in getQualityPerformance:", error);
      res.status(500).json({ success: false, message: "Failed to fetch quality performance" });
    }
  }

  static async addQualityPerformance(req, res) {
    try {
      const pool = await poolPromise;
      const { 
        date, productionOrder, product, producedQty, rejectedQty, 
        reworkedQty, targetRejectionPct, rejectionPct, reworkPct, 
        fpy, topRejectionReason, createdBy 
      } = req.body;
      
      const query = `
        BEGIN TRANSACTION;
        DECLARE @NewId INT;
        SELECT @NewId = ISNULL(MAX(Id), 0) + 1 FROM Dome.dbo.PrdQualityPerformance WITH (UPDLOCK, SERIALIZABLE);
        
        INSERT INTO Dome.dbo.PrdQualityPerformance 
        (Id, PerformanceDate, PrdOrderId, PrdtName, PrdQty, RejectedQty, ReworkedQty, TargetRejectionPercentage, RejectionPercentage, ReworkPercentage, FirstPassYieldPercentage, RejectionReason, CreatedBy, CreatedDate)
        VALUES 
        (@NewId, @Date, @PrdOrderId, @PrdtName, @PrdQty, @RejectedQty, @ReworkedQty, @TargetRejectionPercentage, @RejectionPercentage, @ReworkPercentage, @FirstPassYieldPercentage, @RejectionReason, @CreatedBy, GETDATE());
        
        COMMIT TRANSACTION;
        SELECT @NewId AS InsertedId;
      `;
      
      const request = pool.request();
      request.input('Date', date);
      request.input('PrdOrderId', productionOrder);
      request.input('PrdtName', product);
      request.input('PrdQty', producedQty || 0);
      request.input('RejectedQty', rejectedQty || 0);
      request.input('ReworkedQty', reworkedQty || 0);
      request.input('TargetRejectionPercentage', targetRejectionPct || 0);
      request.input('RejectionPercentage', rejectionPct || 0);
      request.input('ReworkPercentage', reworkPct || 0);
      request.input('FirstPassYieldPercentage', fpy || 0);
      request.input('RejectionReason', topRejectionReason || null);
      request.input('CreatedBy', createdBy || null);
      
      const result = await request.query(query);
      res.json({ success: true, message: 'Quality performance added', id: result.recordset[0].InsertedId });
    } catch (error) {
      console.error("Error in addQualityPerformance:", error);
      res.status(500).json({ success: false, message: "Failed to add quality performance" });
    }
  }
}

module.exports = ProductionTemplateController;
