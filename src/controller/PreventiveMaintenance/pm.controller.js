const { sql, poolPromise } = require('../../database/connection');

exports.getFilters = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    // Years
    const yearQuery = `
      SELECT DISTINCT YEAR(maintenance_date) AS Year
      FROM DOME.dbo.pmspreventivemaintenance
      WHERE maintenance_date IS NOT NULL
      ORDER BY Year DESC
    `;
    const yearResult = await request.query(yearQuery);
    const years = yearResult.recordset.map(row => row.Year);
    
    // Types
    const typeQuery = `SELECT DISTINCT type FROM DOME.dbo.pmsinstrument WHERE type IS NOT NULL ORDER BY type`;
    const typeResult = await request.query(typeQuery);
    const types = typeResult.recordset.map(row => row.type);
    
    // Families
    const familyQuery = `SELECT DISTINCT family FROM DOME.dbo.pmsinstrument WHERE family IS NOT NULL ORDER BY family`;
    const familyResult = await request.query(familyQuery);
    const families = familyResult.recordset.map(row => row.family);
    
    // Instruments
    const instQuery = `SELECT id, instrument_name, instrument_sn FROM DOME.dbo.pmsinstrument ORDER BY instrument_name`;
    const instResult = await request.query(instQuery);
    const instruments = instResult.recordset;

    res.json({
      success: true,
      data: {
        years,
        types,
        families,
        instruments
      }
    });
  } catch (error) {
    console.error('Error fetching PM filters:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch filters', error: error.message });
  }
};

const buildWhereClause = (req, request) => {
  const { year, type, family, instrumentId } = req.query;
  let where = "WHERE 1=1";
  
  if (type) {
    where += " AND i.type = @type";
    request.input('type', sql.NVarChar, type);
  }
  if (family) {
    where += " AND i.family = @family";
    request.input('family', sql.NVarChar, family);
  }
  if (instrumentId) {
    where += " AND i.id = @instrumentId";
    request.input('instrumentId', sql.Int, parseInt(instrumentId));
  }
  
  // Year is handled specially in many queries, but we can pass it
  if (year) {
    request.input('year', sql.Int, parseInt(year));
  } else {
    request.input('year', sql.Int, new Date().getFullYear());
  }
  
  return where;
};

exports.getSummary = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const where = buildWhereClause(req, request);
    
    const query = `
      WITH InstrumentStatus AS (
        SELECT 
          i.id,
          (SELECT COUNT(*) FROM DOME.dbo.pmspreventivemaintenance WHERE instrument_id = i.id AND maintenance_date >= CAST(GETDATE() AS DATE)) as FutureCount
        FROM DOME.dbo.pmsinstrument i
        ${where}
      ),
      MaintenanceStats AS (
        SELECT 
          pm.id,
          pm.maintenance_date,
          CASE
              WHEN pm.maintenance_date < CAST(GETDATE() AS DATE) THEN 'Past Scheduled'
              WHEN pm.maintenance_date = CAST(GETDATE() AS DATE) THEN 'Due Today'
              WHEN pm.maintenance_date > CAST(GETDATE() AS DATE) AND pm.maintenance_date <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE)) THEN 'Due Soon'
              ELSE 'Upcoming'
          END AS StatusCategory
        FROM DOME.dbo.pmspreventivemaintenance pm
        INNER JOIN DOME.dbo.pmsinstrument i ON i.id = pm.instrument_id
        ${where} AND YEAR(pm.maintenance_date) = @year
      )
      
      SELECT
        (SELECT COUNT(*) FROM DOME.dbo.pmsinstrument i ${where}) AS TotalInstruments,
        (SELECT COUNT(*) FROM MaintenanceStats) AS ScheduledMaintenance,
        (SELECT COUNT(*) FROM MaintenanceStats WHERE StatusCategory = 'Due Today') AS DueToday,
        (SELECT COUNT(*) FROM MaintenanceStats WHERE StatusCategory = 'Due Soon') AS DueSoon,
        (SELECT COUNT(*) FROM MaintenanceStats WHERE StatusCategory = 'Upcoming') AS Upcoming,
        (SELECT COUNT(*) FROM MaintenanceStats WHERE StatusCategory = 'Past Scheduled') AS PastScheduled,
        (SELECT COUNT(*) FROM InstrumentStatus WHERE FutureCount = 0) AS WithoutFutureSchedule
    `;
    
    const result = await request.query(query);
    res.json({ success: true, data: result.recordset[0] });
  } catch (error) {
    console.error('Error fetching PM summary:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch summary' });
  }
};

exports.getChartsData = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const where = buildWhereClause(req, request);
    
    // Monthly
    const monthlyQuery = `
      SELECT 
          MONTH(pm.maintenance_date) AS Month,
          COUNT(*) AS Count
      FROM DOME.dbo.pmspreventivemaintenance pm
      INNER JOIN DOME.dbo.pmsinstrument i ON i.id = pm.instrument_id
      ${where} AND YEAR(pm.maintenance_date) = @year
      GROUP BY MONTH(pm.maintenance_date)
    `;
    
    // Type
    const typeQuery = `
      SELECT 
          i.type,
          COUNT(pm.id) AS Count
      FROM DOME.dbo.pmsinstrument i
      LEFT JOIN DOME.dbo.pmspreventivemaintenance pm ON i.id = pm.instrument_id AND YEAR(pm.maintenance_date) = @year
      ${where}
      GROUP BY i.type
      HAVING i.type IS NOT NULL
    `;

    // Family
    const familyQuery = `
      SELECT 
          i.family,
          COUNT(pm.id) AS Count
      FROM DOME.dbo.pmsinstrument i
      LEFT JOIN DOME.dbo.pmspreventivemaintenance pm ON i.id = pm.instrument_id AND YEAR(pm.maintenance_date) = @year
      ${where}
      GROUP BY i.family
      HAVING i.family IS NOT NULL
    `;

    const [monthlyRes, typeRes, familyRes] = await Promise.all([
      request.query(monthlyQuery),
      request.query(typeQuery),
      request.query(familyQuery)
    ]);
    
    // Format monthly data
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyData = monthNames.map((name, index) => {
      const match = monthlyRes.recordset.find(m => m.Month === index + 1);
      return { month: name, count: match ? match.Count : 0 };
    });

    res.json({
      success: true,
      data: {
        monthly: monthlyData,
        byType: typeRes.recordset,
        byFamily: familyRes.recordset
      }
    });
  } catch (error) {
    console.error('Error fetching PM charts data:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch charts data' });
  }
};

exports.getUpcomingMaintenance = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const where = buildWhereClause(req, request);
    
    const query = `
      SELECT 
        pm.id,
        pm.maintenance_date,
        DATEDIFF(DAY, CAST(GETDATE() AS DATE), pm.maintenance_date) AS days_remaining,
        i.instrument_name,
        i.instrument_sn,
        i.type,
        i.family,
        CASE
            WHEN pm.maintenance_date < CAST(GETDATE() AS DATE) THEN 'Past Scheduled'
            WHEN pm.maintenance_date = CAST(GETDATE() AS DATE) THEN 'Due Today'
            WHEN pm.maintenance_date > CAST(GETDATE() AS DATE) AND pm.maintenance_date <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE)) THEN 'Due Soon'
            ELSE 'Upcoming'
        END AS status
      FROM DOME.dbo.pmspreventivemaintenance pm
      INNER JOIN DOME.dbo.pmsinstrument i ON i.id = pm.instrument_id
      ${where} AND pm.maintenance_date >= CAST(GETDATE() AS DATE)
      ORDER BY pm.maintenance_date ASC
    `;
    
    const result = await request.query(query);
    res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error('Error fetching PM upcoming maintenance:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch upcoming maintenance' });
  }
};

exports.getYearlySchedule = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const where = buildWhereClause(req, request);
    
    const { page = 1, limit = 10, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    // Add search to where clause if provided
    let scheduleWhere = where;
    if (search) {
      scheduleWhere += ` AND (i.instrument_name LIKE @search OR i.instrument_sn LIKE @search)`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    request.input('offset', sql.Int, parseInt(offset));
    request.input('limit', sql.Int, parseInt(limit));
    
    const countQuery = `SELECT COUNT(*) as total FROM DOME.dbo.pmsinstrument i ${scheduleWhere}`;
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    const query = `
      SELECT 
        pi.id,
        pi.instrument_name,
        pi.instrument_sn,
        pi.date_of_installation,
        pi.type,
        pi.family,
        pm.maintenance_date,
        CASE
            WHEN pm.maintenance_date < CAST(GETDATE() AS DATE) THEN 'Past Scheduled'
            WHEN pm.maintenance_date = CAST(GETDATE() AS DATE) THEN 'Due Today'
            WHEN pm.maintenance_date > CAST(GETDATE() AS DATE) AND pm.maintenance_date <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE)) THEN 'Due Soon'
            ELSE 'Upcoming'
        END AS status
      FROM (
          SELECT i.id, i.instrument_name, i.instrument_sn, i.date_of_installation, i.type, i.family
          FROM DOME.dbo.pmsinstrument i
          ${scheduleWhere}
          ORDER BY i.instrument_name ASC
          OFFSET @offset ROWS
          FETCH NEXT @limit ROWS ONLY
      ) pi
      LEFT JOIN DOME.dbo.pmspreventivemaintenance pm 
        ON pi.id = pm.instrument_id AND YEAR(pm.maintenance_date) = @year
      ORDER BY pi.instrument_name ASC, pm.maintenance_date ASC
    `;
    
    const result = await request.query(query);
    
    // Group by instrument
    const instrumentsMap = new Map();
    
    result.recordset.forEach(row => {
      if (!instrumentsMap.has(row.id)) {
        instrumentsMap.set(row.id, {
          id: row.id,
          instrument_name: row.instrument_name,
          instrument_sn: row.instrument_sn,
          date_of_installation: row.date_of_installation,
          type: row.type,
          family: row.family,
          schedule: {
            Jan: [], Feb: [], Mar: [], Apr: [], May: [], Jun: [],
            Jul: [], Aug: [], Sep: [], Oct: [], Nov: [], Dec: []
          }
        });
      }
      
      if (row.maintenance_date) {
        const date = new Date(row.maintenance_date);
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = monthNames[date.getMonth()];
        const inst = instrumentsMap.get(row.id);
        
        inst.schedule[month].push({
          date: row.maintenance_date,
          status: row.status
        });
      }
    });
    
    res.json({ 
      success: true, 
      data: Array.from(instrumentsMap.values()),
      total: total
    });
  } catch (error) {
    console.error('Error fetching PM yearly schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch yearly schedule' });
  }
};

exports.addInstrument = async (req, res) => {
  const { instrument_name, instrument_sn, date_of_installation, type, family, maintenanceDates } = req.body;
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    if (!instrument_name) return res.status(400).json({ success: false, message: 'Instrument Name is required' });

    // Fetch next ID for pmsinstrument
    const maxIdQuery = await request.query(`SELECT ISNULL(MAX(id), 0) + 1 AS nextId FROM DOME.dbo.pmsinstrument`);
    const newId = maxIdQuery.recordset[0].nextId;

    request.input('id', sql.Int, newId);
    request.input('name', sql.VarChar, instrument_name);
    request.input('sn', sql.VarChar, instrument_sn || null);
    request.input('doi', sql.Date, date_of_installation ? new Date(date_of_installation) : null);
    request.input('type', sql.VarChar, type || null);
    request.input('family', sql.VarChar, family || null);

    const insertQuery = `
      INSERT INTO DOME.dbo.pmsinstrument (id, instrument_name, instrument_sn, date_of_installation, type, family)
      VALUES (@id, @name, @sn, @doi, @type, @family);
    `;
    await request.query(insertQuery);

    if (maintenanceDates && Array.isArray(maintenanceDates) && maintenanceDates.length > 0) {
      let currentMId = null;
      for (const mDate of maintenanceDates) {
        if (mDate) {
          const mReq = pool.request();
          
          if (currentMId === null) {
            const maxMIdQuery = await mReq.query(`SELECT ISNULL(MAX(id), 0) + 1 AS nextMId FROM DOME.dbo.pmspreventivemaintenance`);
            currentMId = maxMIdQuery.recordset[0].nextMId;
          } else {
            currentMId++;
          }

          mReq.input('m_id', sql.Int, currentMId);
          mReq.input('inst_id', sql.Int, newId);
          mReq.input('m_date', sql.Date, new Date(mDate));
          await mReq.query(`
            INSERT INTO DOME.dbo.pmspreventivemaintenance (id, instrument_id, maintenance_date)
            VALUES (@m_id, @inst_id, @m_date)
          `);
        }
      }
    }

    res.json({ success: true, message: 'Instrument added successfully' });
  } catch (error) {
    console.error('Error adding instrument:', error);
    res.status(500).json({ success: false, message: 'Failed to add instrument' });
  }
};

exports.updateInstrument = async (req, res) => {
  const { id } = req.params;
  const { instrument_name, instrument_sn, date_of_installation, type, family, maintenanceDates } = req.body;
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    if (!id) return res.status(400).json({ success: false, message: 'Instrument ID is required' });

    request.input('id', sql.Int, id);
    request.input('name', sql.VarChar, instrument_name);
    request.input('sn', sql.VarChar, instrument_sn || null);
    request.input('doi', sql.Date, date_of_installation ? new Date(date_of_installation) : null);
    request.input('type', sql.VarChar, type || null);
    request.input('family', sql.VarChar, family || null);

    const updateQuery = `
      UPDATE DOME.dbo.pmsinstrument 
      SET instrument_name = @name, instrument_sn = @sn, date_of_installation = @doi, type = @type, family = @family
      WHERE id = @id
    `;
    await request.query(updateQuery);

    const deleteReq = pool.request();
    deleteReq.input('id', sql.Int, id);
    await deleteReq.query(`DELETE FROM DOME.dbo.pmspreventivemaintenance WHERE instrument_id = @id`);

    if (maintenanceDates && Array.isArray(maintenanceDates) && maintenanceDates.length > 0) {
      let currentMId = null;
      for (const mDate of maintenanceDates) {
        if (mDate) {
          const mReq = pool.request();

          if (currentMId === null) {
            const maxMIdQuery = await mReq.query(`SELECT ISNULL(MAX(id), 0) + 1 AS nextMId FROM DOME.dbo.pmspreventivemaintenance`);
            currentMId = maxMIdQuery.recordset[0].nextMId;
          } else {
            currentMId++;
          }

          mReq.input('m_id', sql.Int, currentMId);
          mReq.input('inst_id', sql.Int, id);
          mReq.input('m_date', sql.Date, new Date(mDate));
          await mReq.query(`
            INSERT INTO DOME.dbo.pmspreventivemaintenance (id, instrument_id, maintenance_date)
            VALUES (@m_id, @inst_id, @m_date)
          `);
        }
      }
    }

    res.json({ success: true, message: 'Instrument updated successfully' });
  } catch (error) {
    console.error('Error updating instrument:', error);
    res.status(500).json({ success: false, message: 'Failed to update instrument' });
  }
};
