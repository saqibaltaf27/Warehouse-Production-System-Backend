const { poolPromise } = require('../../database/connection');

const ensureTemplateId = async (pool) => {
  await pool.request().query(`
    IF COL_LENGTH('Dome.dbo.PMSCOATemplate', 'TemplateId') IS NULL
    BEGIN
      ALTER TABLE Dome.dbo.PMSCOATemplate ADD TemplateId INT IDENTITY(1,1) NOT NULL
    END
  `);
};

const saveCOATemplate = async (req, res) => {
  try {
    const { line, templateName, templateId, id, description, header, footer, createdBy } = req.body;
    const lineValue = String(line || '').trim();

    if (!lineValue) {
      return res.status(400).json({ success: false, message: "Product line is required" });
    }

    const pool = await poolPromise;
    await ensureTemplateId(pool);
    const asJson = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? {}));
    const createdByValue = createdBy || 0;
    const rowId = Number(id || templateId);
    await pool.request()
      .input('Line', lineValue)
      .input('TemplateName', String(templateName || '').trim())
      .input('Description', asJson(description))
      .input('Header', asJson(header))
      .input('Footer', asJson(footer))
      .input('CreatedBy', createdByValue)
      .input('ID', Number.isInteger(rowId) && rowId > 0 ? rowId : null)
      .query(`
        IF @ID IS NOT NULL AND EXISTS (
          SELECT 1 FROM Dome.dbo.PMSCOATemplate WHERE ID = @ID
        )
        BEGIN
          UPDATE Dome.dbo.PMSCOATemplate
          SET Line = @Line,
              TemplateName = @TemplateName,
              Description = @Description,
              Header = @Header,
              Footer = @Footer,
              CreatedBy = @CreatedBy
          WHERE ID = @ID
        END
        ELSE
        BEGIN
          INSERT INTO Dome.dbo.PMSCOATemplate (Line, TemplateName, Description, Header, Footer, CreatedBy, CreatedDate)
          VALUES (@Line, @TemplateName, @Description, @Header, @Footer, @CreatedBy, GETDATE())
        END
      `);

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
    await ensureTemplateId(pool);
    const result = await pool.request().query(`
      SELECT
        T.ID,
        T.Line,
        T.TemplateName,
        CONVERT(varchar(23), T.CreatedDate, 121) AS CreatedDateKey,
        T.Description,
        T.Header,
        T.Footer,
        T.CreatedBy,
        ISNULL(E.FirstName, CAST(T.CreatedBy AS NVARCHAR(50))) AS CreatedByName,
        T.CreatedDate
      FROM Dome.dbo.PMSCOATemplate T
      LEFT JOIN HCM_GMS.dbo.MstEmployee E
        ON E.EmpID = TRY_CAST(T.CreatedBy AS INT)
      WHERE T.Line IS NOT NULL AND LTRIM(RTRIM(T.Line)) <> ''
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
    await ensureTemplateId(pool);
    const result = await pool.request()
      .input('Line', line)
      .query(`
        SELECT
          ID,
          Line,
          ISNULL(TemplateName, '') AS TemplateName,
          CONVERT(varchar(23), CreatedDate, 121) AS CreatedDateKey,
          Description,
          Header,
          Footer
        FROM Dome.dbo.PMSCOATemplate
        WHERE LOWER(LTRIM(RTRIM(Line))) = LOWER(LTRIM(RTRIM(@Line)))
        ORDER BY CreatedDate DESC
      `);

    if (!result.recordset.length) {
      return res.json({ success: false, message: 'No template found for this product line' });
    }

    res.json({ success: true, data: result.recordset });
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
