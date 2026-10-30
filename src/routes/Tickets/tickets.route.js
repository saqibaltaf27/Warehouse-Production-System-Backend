const { sql, poolPromise } = require('../../database/connection');
const authenticateToken = require('../../middleware/auth.middleware');
const express = require('express');
const router = express.Router();

const TICKET_TYPES = ['Quality', 'Production', 'Engineering'];
const TICKET_STATUSES = ['Pending', 'In Process', 'Closed'];
const TICKETS_TABLE = 'Dome.dbo.TicketRequests';

const parseRemarks = (value) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => {
      const author = String(item.author || item.name || '').trim();
      const empFromAuthor = author.includes(' - ') ? author.split(' - ')[0] : '';
      return {
        RemarkId: index + 1,
        Remark: item.comment || item.remark || '',
        CreatedAt: item.date || item.createdAt || null,
        EmpId: item.empId || empFromAuthor || null,
        FirstName: author.includes(' - ') ? author.split(' - ').slice(1).join(' - ') : (item.name || author || ''),
        _raw: item,
      };
    });
  } catch {
    return [];
  }
};

const toStorageRemarks = (remarks) =>
  remarks.map((item) => {
    if (item._raw?.author != null || item._raw?.comment != null) {
      return {
        author: item._raw.author,
        date: item._raw.date,
        comment: item._raw.comment,
      };
    }
    const name = String(item.FirstName || item.name || '').trim();
    const empId = item.EmpId || item.empId || '';
    return {
      author: name ? `${empId} - ${name}` : String(empId || ''),
      date: item.CreatedAt || item.createdAt || new Date().toISOString(),
      comment: item.Remark || item.remark || '',
    };
  });

const listTickets = async (req, res) => {
  try {
    const empId = parseInt(req.user?.empId, 10);
    const ticketType = String(req.query.type || '').trim();
    const mine = req.query.mine !== '0';
    if (mine && !empId) {
      return res.status(400).json({ success: false, message: 'Employee id is missing' });
    }
    if (ticketType && !TICKET_TYPES.includes(ticketType)) {
      return res.status(400).json({ success: false, message: 'Ticket type must be Quality, Production, or Engineering' });
    }
    const search = String(req.query.search || '').trim();
    const assignedTo = String(req.query.assignedTo || '').trim();
    const createdBy = String(req.query.createdBy || '').trim();
    const status = String(req.query.status || '').trim();
    const limit = Math.max(parseInt(req.query.limit, 10) || 0, 0);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const pool = await poolPromise;
    const request = pool.request();
    request.input('EmpId', sql.Int, mine ? empId : 0);
    request.input('TicketType', sql.NVarChar(100), ticketType);
    request.input('Search', sql.NVarChar(200), search);
    request.input('AssignedTo', sql.NVarChar(50), assignedTo);
    request.input('CreatedBy', sql.NVarChar(50), createdBy);
    request.input('Status', sql.NVarChar(50), status);
    request.input('Limit', sql.Int, limit);
    request.input('Offset', sql.Int, offset);
    const result = await request.query(`
      WITH scoped AS (
        SELECT
          t.Ticketid AS TicketId,
          t.EmpId,
          e.FirstName,
          t.TicketType,
          CASE
            WHEN REPLACE(LOWER(ISNULL(t.Status, '')), ' ', '') IN ('inprocess', 'inprogress') THEN 'In Process'
            WHEN LOWER(ISNULL(t.Status, '')) = 'closed' THEN 'Closed'
            ELSE 'Pending'
          END AS Status,
          t.TicketDescription,
          t.AssignedTo,
          a.FirstName AS AssignedName,
          CONVERT(varchar(19), t.CreatedAt, 120) AS CreatedAt,
          CONVERT(varchar(19), t.UpdateDate, 120) AS UpdateDate
        FROM ${TICKETS_TABLE} t
        LEFT JOIN HCM_GMS.dbo.MstEmployee e ON e.EmpID = t.EmpId
        LEFT JOIN HCM_GMS.dbo.MstEmployee a ON a.EmpID = TRY_CAST(t.AssignedTo AS INT)
        WHERE (@EmpId = 0 OR t.EmpId = @EmpId)
          AND (
            (@TicketType = '' AND t.TicketType IN ('Quality', 'Production', 'Engineering'))
            OR t.TicketType = @TicketType
          )
          AND (
            @Search = ''
            OR CAST(t.Ticketid AS nvarchar(20)) LIKE '%' + @Search + '%'
            OR t.TicketDescription LIKE '%' + @Search + '%'
            OR e.FirstName LIKE '%' + @Search + '%'
          )
          AND (@AssignedTo = '' OR CAST(t.AssignedTo AS nvarchar(50)) = @AssignedTo)
          AND (@CreatedBy = '' OR CAST(t.EmpId AS nvarchar(50)) = @CreatedBy)
      )
      SELECT *
      FROM (
        SELECT
          scoped.*,
          ROW_NUMBER() OVER (PARTITION BY scoped.Status ORDER BY scoped.TicketId DESC) AS RowNum,
          COUNT(*) OVER (PARTITION BY scoped.Status) AS StatusTotal
        FROM scoped
        WHERE (@Status = '' OR scoped.Status = @Status)
      ) paged
      WHERE (@Limit = 0 OR (paged.RowNum > @Offset AND paged.RowNum <= @Offset + @Limit))
      ORDER BY paged.TicketId DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error listing tickets:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createTicket = async (req, res) => {
  try {
    const ticketType = String(req.body.ticketType || '').trim();
    const description = String(req.body.description || '').trim();
    const empId = parseInt(req.user?.empId, 10);

    if (!TICKET_TYPES.includes(ticketType)) {
      return res.status(400).json({ success: false, message: 'Ticket type must be Quality, Production, or Engineering' });
    }
    if (!description) {
      return res.status(400).json({ success: false, message: 'Description is required' });
    }
    if (!empId) {
      return res.status(400).json({ success: false, message: 'Employee id is missing' });
    }

    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const idRequest = new sql.Request(transaction);
      const idResult = await idRequest.query(`
        SELECT ISNULL(MAX(Ticketid), 0) + 1 AS NextId
        FROM ${TICKETS_TABLE} WITH (UPDLOCK, HOLDLOCK)
      `);
      const ticketId = idResult.recordset[0].NextId;

      const insertRequest = new sql.Request(transaction);
      insertRequest.input('TicketId', sql.Int, ticketId);
      insertRequest.input('EmpId', sql.Int, empId);
      insertRequest.input('TicketType', sql.NVarChar(100), ticketType);
      insertRequest.input('Status', sql.NVarChar(50), 'Pending');
      insertRequest.input('TicketDescription', sql.NVarChar(sql.MAX), description);
      await insertRequest.query(`
        INSERT INTO ${TICKETS_TABLE}
          (Ticketid, EmpId, TicketType, Status, TicketDescription, AssignedTo, CreatedAt, UpdateDate, ClosingRemarks)
        VALUES
          (@TicketId, @EmpId, @TicketType, @Status, @TicketDescription, NULL, SYSDATETIME(), SYSDATETIME(), NULL)
      `);
      await transaction.commit();
      res.json({ success: true, data: { ticketId } });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Error creating ticket:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

router.get('/employees', authenticateToken, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT EmpID, FirstName
      FROM HCM_GMS.dbo.MstEmployee
      WHERE flgActive = 1
        AND FirstName IS NOT NULL
        AND (
          DepartmentName LIKE '%production%'
          OR DepartmentName LIKE '%quality%'
          OR DepartmentName LIKE '%engineer%'
        )
      ORDER BY FirstName
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error listing ticket employees:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const pool = await poolPromise;
    const request = pool.request();
    request.input('TicketId', sql.Int, ticketId);
    const ticket = await request.query(`
      SELECT
        t.Ticketid AS TicketId, t.EmpId, e.FirstName, t.TicketType, t.Status, t.TicketDescription,
        t.AssignedTo, a.FirstName AS AssignedName,
        CONVERT(varchar(19), t.CreatedAt, 120) AS CreatedAt,
        CONVERT(varchar(19), t.UpdateDate, 120) AS UpdateDate,
        t.ClosingRemarks
      FROM ${TICKETS_TABLE} t
      LEFT JOIN HCM_GMS.dbo.MstEmployee e ON e.EmpID = t.EmpId
      LEFT JOIN HCM_GMS.dbo.MstEmployee a ON a.EmpID = TRY_CAST(t.AssignedTo AS INT)
      WHERE t.Ticketid = @TicketId
    `);
    const row = ticket.recordset[0];
    if (!row) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const remarks = parseRemarks(row.ClosingRemarks);
    res.json({
      success: true,
      data: {
        ...row,
        remarks: remarks.map(({ RemarkId, Remark, CreatedAt, EmpId, FirstName }) => ({
          RemarkId,
          Remark,
          CreatedAt,
          EmpId,
          FirstName,
        })),
      },
    });
  } catch (err) {
    console.error('Error loading ticket:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const status = req.body.status != null ? String(req.body.status).trim() : null;
    const hasAssignee = Object.prototype.hasOwnProperty.call(req.body, 'assignedTo');
    if (status && !TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Pending, In Process, or Closed' });
    }
    const assignedTo = hasAssignee && req.body.assignedTo ? parseInt(req.body.assignedTo, 10) : null;
    const pool = await poolPromise;
    if (status === 'Closed') {
      const existing = await pool.request()
        .input('TicketId', sql.Int, ticketId)
        .query(`SELECT ClosingRemarks FROM ${TICKETS_TABLE} WHERE Ticketid = @TicketId`);
      if (!existing.recordset[0]) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }
      const remarks = parseRemarks(existing.recordset[0].ClosingRemarks);
      if (!remarks.length) {
        return res.status(400).json({ success: false, message: 'Add a closing remark before closing this ticket' });
      }
    }
    const request = pool.request();
    request.input('TicketId', sql.Int, ticketId);
    request.input('Status', sql.NVarChar(50), status);
    request.input('AssignedTo', sql.Int, assignedTo);
    request.input('HasAssignee', sql.Bit, hasAssignee ? 1 : 0);
    const result = await request.query(`
      UPDATE ${TICKETS_TABLE}
      SET
        Status = COALESCE(@Status, Status),
        AssignedTo = CASE WHEN @HasAssignee = 1 THEN CAST(@AssignedTo AS VARCHAR(MAX)) ELSE AssignedTo END,
        UpdateDate = CASE WHEN @Status IS NOT NULL OR @HasAssignee = 1 THEN SYSDATETIME() ELSE UpdateDate END
      WHERE Ticketid = @TicketId
    `);
    if (!result.rowsAffected[0]) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating ticket:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/remarks', authenticateToken, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const remark = String(req.body.remark || '').trim();
    const empId = parseInt(req.user?.empId, 10) || null;
    if (!remark) {
      return res.status(400).json({ success: false, message: 'Remark is required' });
    }
    const pool = await poolPromise;
    const current = await pool.request()
      .input('TicketId', sql.Int, ticketId)
      .query(`SELECT ClosingRemarks FROM ${TICKETS_TABLE} WHERE Ticketid = @TicketId`);
    if (!current.recordset[0]) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const employee = empId
      ? await pool.request().input('EmpId', sql.Int, empId).query(`SELECT FirstName FROM HCM_GMS.dbo.MstEmployee WHERE EmpID = @EmpId`)
      : { recordset: [] };
    const firstName = employee.recordset[0]?.FirstName || '';
    const remarks = parseRemarks(current.recordset[0].ClosingRemarks);
    remarks.push({
      EmpId: empId,
      FirstName: firstName,
      Remark: remark,
      CreatedAt: new Date().toISOString(),
    });
    await pool.request()
      .input('TicketId', sql.Int, ticketId)
      .input('ClosingRemarks', sql.NVarChar(sql.MAX), JSON.stringify(toStorageRemarks(remarks)))
      .query(`
        UPDATE ${TICKETS_TABLE}
        SET ClosingRemarks = @ClosingRemarks, UpdateDate = SYSDATETIME()
        WHERE Ticketid = @TicketId
      `);
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding remark:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/', authenticateToken, listTickets);
router.post('/', authenticateToken, createTicket);

module.exports = router;
