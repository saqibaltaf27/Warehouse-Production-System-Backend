const { poolPromise } = require('../../database/connection');

const saveCOATemplate = async (req, res) => {
  try {
    const { itemCode, description, createdBy } = req.body;
    
    if (!itemCode) {
      return res.status(400).json({ success: false, message: "ItemCode is required" });
    }

    const pool = await poolPromise;
    const query = `
      IF EXISTS (SELECT 1 FROM Dome.dbo.PMSCOATemplate WHERE ItemCode = @ItemCode)
      BEGIN
        UPDATE Dome.dbo.PMSCOATemplate 
        SET Description = @Description, CreatedBy = @CreatedBy, CreatedDate = GETDATE()
        WHERE ItemCode = @ItemCode
      END
      ELSE
      BEGIN
        INSERT INTO Dome.dbo.PMSCOATemplate (ItemCode, Description, CreatedBy)
        VALUES (@ItemCode, @Description, @CreatedBy)
      END
    `;

    await pool.request()
      .input('ItemCode', itemCode)
      .input('Description', typeof description === 'string' ? description : JSON.stringify(description))
      .input('CreatedBy', createdBy || 0)
      .query(query);

    res.status(201).json({
      success: true,
      message: "Template saved successfully"
    });
  } catch (error) {
    console.error("Error saving COA template:", error);
    res.status(500).json({ success: false, message: "Failed to save COA template" });
  }
};

const getCOATemplate = async (req, res) => {
  try {
    const { itemCode } = req.params;
    
    if (!itemCode) {
      return res.status(400).json({ success: false, message: "ItemCode is required" });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('ItemCode', itemCode)
      .query(`SELECT Description FROM Dome.dbo.PMSCOATemplate WHERE ItemCode = @ItemCode`);

    if (result.recordset.length > 0) {
      res.json({
        success: true,
        data: result.recordset[0].Description
      });
    } else {
      res.json({
        success: false,
        message: "No template found for this item"
      });
    }
  } catch (error) {
    console.error("Error fetching COA template:", error);
    res.status(500).json({ success: false, message: "Failed to fetch COA template" });
  }
};

const getAllCOATemplates = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT ItemCode, Description, CreatedBy, CreatedDate 
      FROM Dome.dbo.PMSCOATemplate
      ORDER BY CreatedDate DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Error fetching all COA templates:", error);
    res.status(500).json({ success: false, message: "Failed to fetch all COA templates" });
  }
};

module.exports = {
  saveCOATemplate,
  getCOATemplate,
  getAllCOATemplates
};
