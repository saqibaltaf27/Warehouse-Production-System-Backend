const { sql, poolPromise } = require('../../database/connection');
const { uploadPolicyFile, deletePolicyFile, getPolicyFileUrl } = require('../../utils/idrive');

const getCreatedBy = (req) => {
  const raw = req.user?.empId || req.user?.userId || req.body?.createdBy;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

exports.listPolicies = async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const pool = await poolPromise;
    const request = pool.request();

    let where = '';
    if (search) {
      where = `WHERE P.Title LIKE @Search OR P.Department LIKE @Search`;
      request.input('Search', sql.NVarChar, `%${search}%`);
    }

    const result = await request.query(`
      SELECT
        P.Id,
        P.Title,
        P.Department,
        P.[File] AS FilePath,
        P.CreatedBy,
        ISNULL(E.FirstName, CAST(P.CreatedBy AS NVARCHAR(50))) AS CreatedByName,
        P.CreatedAt
      FROM Dome.dbo.PMSPolicy P
      LEFT JOIN HCM_GMS.dbo.MstEmployee E ON E.EmpID = P.CreatedBy
      ${where}
      ORDER BY P.CreatedAt DESC, P.Id DESC
    `);

    res.json({ success: true, data: result.recordset || [] });
  } catch (error) {
    console.error('Error in listPolicies:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to list policies' });
  }
};

exports.createPolicy = async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const department = String(req.body?.department || '').trim();
    const createdBy = getCreatedBy(req); // from JWT empId
    const file = req.file;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    if (!department) {
      return res.status(400).json({ success: false, message: 'Department is required' });
    }
    if (!createdBy) {
      return res.status(400).json({ success: false, message: 'CreatedBy (logged-in empId) is required' });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: 'Policy file is required' });
    }

    const filePath = await uploadPolicyFile({
      buffer: file.buffer,
      originalName: file.originalname,
      contentType: file.mimetype,
    });

    const pool = await poolPromise;
    const nextIdResult = await pool.request().query(`
      SELECT ISNULL(MAX(Id), 0) + 1 AS NextId FROM Dome.dbo.PMSPolicy
    `);
    const nextId = nextIdResult.recordset[0].NextId;

    const insert = pool.request();
    insert.input('Id', sql.Int, nextId);
    insert.input('Title', sql.NVarChar(500), title);
    insert.input('Department', sql.NVarChar(200), department);
    insert.input('File', sql.NVarChar(sql.MAX), filePath);
    insert.input('CreatedBy', sql.Int, createdBy);

    await insert.query(`
      INSERT INTO Dome.dbo.PMSPolicy (Id, Title, Department, [File], CreatedBy, CreatedAt)
      VALUES (@Id, @Title, @Department, @File, @CreatedBy, GETDATE())
    `);

    res.status(201).json({
      success: true,
      message: 'Policy uploaded successfully',
      data: {
        Id: nextId,
        Title: title,
        Department: department,
        FilePath: filePath,
        CreatedBy: createdBy,
      },
    });
  } catch (error) {
    console.error('Error in createPolicy:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create policy' });
  }
};

exports.getPolicyFileUrl = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid policy id' });
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('Id', sql.Int, id)
      .query(`SELECT [File] AS FilePath, Title FROM Dome.dbo.PMSPolicy WHERE Id = @Id`);

    const row = result.recordset[0];
    if (!row?.FilePath) {
      return res.status(404).json({ success: false, message: 'Policy file not found' });
    }

    const url = await getPolicyFileUrl(row.FilePath, 3600);
    res.json({
      success: true,
      data: {
        url,
        title: row.Title,
        path: row.FilePath,
      },
    });
  } catch (error) {
    console.error('Error in getPolicyFileUrl:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get file url' });
  }
};

exports.deletePolicy = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid policy id' });
    }

    const pool = await poolPromise;
    const existing = await pool.request()
      .input('Id', sql.Int, id)
      .query(`SELECT [File] AS FilePath FROM Dome.dbo.PMSPolicy WHERE Id = @Id`);

    const row = existing.recordset[0];
    if (!row) {
      return res.status(404).json({ success: false, message: 'Policy not found' });
    }

    await pool.request()
      .input('Id', sql.Int, id)
      .query(`DELETE FROM Dome.dbo.PMSPolicy WHERE Id = @Id`);

    try {
      await deletePolicyFile(row.FilePath);
    } catch (fileErr) {
      console.error('Policy DB deleted but iDrive delete failed:', fileErr.message);
    }

    res.json({ success: true, message: 'Policy deleted successfully' });
  } catch (error) {
    console.error('Error in deletePolicy:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete policy' });
  }
};
