const { sql, poolPromise } = require("../../database/connection");

class ProductionTemplateModel {
  static async getProductionOrders() {
    try {
      const pool = await poolPromise;
      // Note: The user requested to use LDS_LIVE database
      const query = `
        SELECT 
            DocNum AS ProductionOrderNo,
            ProdName AS ProductName
        FROM lds_live.dbo.OWOR
        ORDER BY DocNum DESC;
      `;
      const result = await pool.request().query(query);
      return result.recordset;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = ProductionTemplateModel;
