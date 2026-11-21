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
    const rawNames = Array.isArray(req.body?.itemNames)
      ? req.body.itemNames
      : [req.body?.itemName || req.body?.ItemName];
    const itemNames = [...new Set(rawNames.map((name) => String(name || '').trim()).filter(Boolean))];
    const manHourRaw = req.body?.manHour ?? req.body?.ManHour;
    const createdBy = getCreatedBy(req);

    if (!itemNames.length) {
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
      SELECT ISNULL(MAX(Id), 0) AS MaxId FROM Dome.dbo.PMSStandardManHours
    `);
    let nextId = nextIdResult.recordset[0].MaxId;
    let created = 0;
    let updated = 0;

    for (const itemName of itemNames) {
      const existing = await pool.request()
        .input('ItemName', sql.NVarChar(200), itemName)
        .query(`
          SELECT TOP 1 Id
          FROM Dome.dbo.PMSStandardManHours
          WHERE ItemName = @ItemName
        `);
      if (existing.recordset[0]) {
        await pool.request()
          .input('Id', sql.Int, existing.recordset[0].Id)
          .input('ManHour', sql.Decimal(18, 2), manHour)
          .query(`
            UPDATE Dome.dbo.PMSStandardManHours
            SET ManHour = @ManHour
            WHERE Id = @Id
          `);
        updated += 1;
      } else {
        nextId += 1;
        await pool.request()
          .input('Id', sql.Int, nextId)
          .input('ItemName', sql.NVarChar(200), itemName)
          .input('ManHour', sql.Decimal(18, 2), manHour)
          .input('CreatedBy', sql.Int, createdBy)
          .query(`
            INSERT INTO Dome.dbo.PMSStandardManHours (Id, ItemName, ManHour, CreatedBy, CreatedAt)
            VALUES (@Id, @ItemName, @ManHour, @CreatedBy, GETDATE())
          `);
        created += 1;
      }
    }

    res.status(201).json({
      success: true,
      message: itemNames.length > 1
        ? `Saved man hour for ${itemNames.length} items`
        : 'Standard unit saved',
      data: { created, updated, ManHour: manHour },
    });
  } catch (error) {
    console.error('Error in createStandard:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create standard',
    });
  }
};

exports.updateStandard = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const manHour = Number(req.body?.manHour ?? req.body?.ManHour);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Id is required' });
    }
    if (Number.isNaN(manHour) || manHour < 0) {
      return res.status(400).json({ success: false, message: 'Valid ManHour is required' });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('Id', sql.Int, id)
      .input('ManHour', sql.Decimal(18, 2), manHour)
      .query(`
        UPDATE Dome.dbo.PMSStandardManHours
        SET ManHour = @ManHour
        WHERE Id = @Id
      `);

    if (!result.rowsAffected?.[0]) {
      return res.status(404).json({ success: false, message: 'Standard not found' });
    }

    res.json({ success: true, message: 'Standard unit updated', data: { Id: id, ManHour: manHour } });
  } catch (error) {
    console.error('Error in updateStandard:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update standard' });
  }
};
