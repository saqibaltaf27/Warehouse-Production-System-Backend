const { sql, poolPromise } = require('../../database/connection');

const getCreatedBy = (req) => {
  const raw = req.user?.empId || req.user?.userId || req.body?.createdBy;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

exports.getItems = async (_req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT ItemCode, ProdName
      FROM LDS_LIVE.dbo.OWOR
      WHERE ItemCode IS NOT NULL AND LTRIM(RTRIM(ItemCode)) <> ''
      ORDER BY DocNum DESC
    `);

    const seen = new Set();
    const data = [];
    for (const row of result.recordset || []) {
      const code = String(row.ItemCode || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      data.push({
        ItemCode: code,
        ProdName: row.ProdName || '',
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error in getStandardUnitItems:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch items',
    });
  }
};

exports.listStandards = async (_req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT
        S.Id,
        S.ItemName,
        S.ManHour,
        S.CreatedBy,
        S.CreatedAt,
        ISNULL(E.FirstName, CAST(S.CreatedBy AS NVARCHAR(50))) AS CreatedByName,
        ISNULL(O.ProdName, '') AS ItemDescription
      FROM Dome.dbo.PMSStandardManHours S
      LEFT JOIN HCM_GMS.dbo.MstEmployee E ON E.EmpID = S.CreatedBy
      OUTER APPLY (
        SELECT TOP 1 ProdName
        FROM LDS_LIVE.dbo.OWOR W
        WHERE W.ItemCode COLLATE DATABASE_DEFAULT = S.ItemName COLLATE DATABASE_DEFAULT
        ORDER BY W.DocNum DESC
      ) O
      ORDER BY S.Id DESC
    `);

    res.json({ success: true, data: result.recordset || [] });
  } catch (error) {
    console.error('Error in listStandards:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list standards',
    });
  }
};

exports.createStandard = async (req, res) => {
  try {
    const itemName = String(req.body?.itemName || req.body?.ItemName || '').trim();
    const manHourRaw = req.body?.manHour ?? req.body?.ManHour;
    const createdBy = getCreatedBy(req);

    if (!itemName) {
      return res.status(400).json({ success: false, message: 'ItemName is required' });
    }
    const manHour = Number(manHourRaw);
    if (Number.isNaN(manHour) || manHour < 0) {
      return res.status(400).json({ success: false, message: 'Valid ManHour is required' });
    }
    if (!createdBy) {
      return res.status(400).json({ success: false, message: 'CreatedBy (logged-in empId) is required' });
    }

    const pool = await poolPromise;
    const nextIdResult = await pool.request().query(`
      SELECT ISNULL(MAX(Id), 0) + 1 AS NextId FROM Dome.dbo.PMSStandardManHours
    `);
    const nextId = nextIdResult.recordset[0].NextId;

    await pool.request()
      .input('Id', sql.Int, nextId)
      .input('ItemName', sql.NVarChar(200), itemName)
      .input('ManHour', sql.Decimal(18, 2), manHour)
      .input('CreatedBy', sql.Int, createdBy)
      .query(`
        INSERT INTO Dome.dbo.PMSStandardManHours (Id, ItemName, ManHour, CreatedBy, CreatedAt)
        VALUES (@Id, @ItemName, @ManHour, @CreatedBy, GETDATE())
      `);

    res.status(201).json({
      success: true,
      message: 'Standard unit saved',
      data: {
        Id: nextId,
        ItemName: itemName,
        ManHour: manHour,
        CreatedBy: createdBy,
      },
    });
  } catch (error) {
    console.error('Error in createStandard:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create standard',
    });
  }
};
