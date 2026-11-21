const { poolPromise } = require('../../database/connection');

const saveCOATemplate = async (req, res) => {
  try {
    const { itemCode, itemCodes, description, createdBy } = req.body;
    const codes = Array.isArray(itemCodes)
      ? itemCodes.map((code) => String(code || '').trim()).filter(Boolean)
      : (itemCode ? [String(itemCode).trim()] : []);

    if (!codes.length) {
      return res.status(400).json({ success: false, message: "At least one ItemCode is required" });
    }

    const pool = await poolPromise;
    const descriptionValue = typeof description === 'string' ? description : JSON.stringify(description);
    const createdByValue = createdBy || 0;
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

    for (const code of codes) {
      await pool.request()
        .input('ItemCode', code)
        .input('Description', descriptionValue)
        .input('CreatedBy', createdByValue)
        .query(query);
    }

    res.status(201).json({
      success: true,
      message: codes.length > 1
        ? `Template saved for ${codes.length} products`
        : "Template saved successfully"
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
      SELECT
        T.ItemCode,
        I.ItemName,
        T.Description,
        T.CreatedBy,
        ISNULL(E.FirstName, CAST(T.CreatedBy AS NVARCHAR(50))) AS CreatedByName,
        T.CreatedDate
      FROM Dome.dbo.PMSCOATemplate T
      LEFT JOIN LDS_LIVE.dbo.OITM I
        ON I.ItemCode COLLATE DATABASE_DEFAULT = T.ItemCode COLLATE DATABASE_DEFAULT
      LEFT JOIN HCM_GMS.dbo.MstEmployee E
        ON E.EmpID = TRY_CAST(T.CreatedBy AS INT)
      ORDER BY T.CreatedDate DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Error fetching all COA templates:", error);
    res.status(500).json({ success: false, message: "Failed to fetch all COA templates" });
  }
};

const getCOATemplateByLine = async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!line) {
      return res.status(400).json({ success: false, message: 'Product line is required' });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('Line', line)
      .query(`
        SELECT TOP 1 Line, Description, Header, Footer
        FROM Dome.dbo.PMSCOATemplate
        WHERE LOWER(LTRIM(RTRIM(Line))) = LOWER(LTRIM(RTRIM(@Line)))
      `);

    if (!result.recordset.length) {
      return res.json({ success: false, message: 'No template found for this product line' });
    }

    res.json({ success: true, data: result.recordset[0] });
  } catch (error) {
    console.error('Error fetching COA template by line:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch COA template' });
  }
};

module.exports = {
  saveCOATemplate,
  getCOATemplate,
  getCOATemplateByLine,
  getAllCOATemplates
};
