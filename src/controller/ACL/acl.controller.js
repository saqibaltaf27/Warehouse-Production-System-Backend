const { sql, poolPromise } = require('../../database/connection');

exports.getEmployees = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const { search } = req.query;

        let query = `
            SELECT 
                empid AS id, 
                FirstName AS firstName, 
                '' AS lastName, 
                OfficeEmail AS email, 
                DepartmentName AS department, 
                Designationname AS designation
            FROM HCM_GMS.dbo.MstEmployee
            WHERE flgActive = 1
        `;

        if (search) {
            query += ` AND (FirstName LIKE @search OR empid LIKE @search)`;
            request.input('search', sql.NVarChar, `%${search}%`);
        } else {
            // Default to logged-in user if no search query provided
            const empId = req.user?.empId;
            if (empId) {
                query += ` AND empid = @empid`;
                request.input('empid', sql.NVarChar, empId);
            }
        }

        // Add a limit to avoid fetching the entire database if search is too broad
        query = query.replace('SELECT', 'SELECT TOP 50');

        const result = await request.query(query);

        res.json({
            success: true,
            data: result.recordset
        });

    } catch (err) {
        console.error('Error fetching employees:', err);
        res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
};

exports.addPermission = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        
        const {
            Title,
            Route,
            Method,
            AccessText,
            main_module,
            sub_module,
            child_module,
            child_module_last
        } = req.body;

        if (!Title || !Route || !Method || !AccessText || !main_module) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const query = `
            DECLARE @NewId INT = (SELECT ISNULL(MAX(Id), 0) + 1 FROM DOME.dbo.Permission);
            
            INSERT INTO DOME.dbo.Permission (
                Id, Title, Route, Method, AccessText, 
                main_module, sub_module, child_module, child_module_last, 
                CreatedAt, UpdatedAt
            )
            OUTPUT INSERTED.*
            VALUES (
                @NewId, @Title, @Route, @Method, @AccessText, 
                @main_module, @sub_module, @child_module, @child_module_last, 
                GETDATE(), GETDATE()
            );
        `;

        request.input('Title', sql.NVarChar, Title);
        request.input('Route', sql.NVarChar, Route);
        request.input('Method', sql.NVarChar, Method);
        request.input('AccessText', sql.NVarChar, AccessText);
        request.input('main_module', sql.NVarChar, main_module);
        request.input('sub_module', sql.NVarChar, sub_module || null);
        request.input('child_module', sql.NVarChar, child_module || null);
        request.input('child_module_last', sql.NVarChar, child_module_last || null);

        const result = await request.query(query);

        res.json({
            success: true,
            data: result.recordset[0],
            message: 'Permission created successfully'
        });

    } catch (err) {
        console.error('Error adding permission:', err);
        res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
};

exports.getPermissions = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM DOME.dbo.Permission ORDER BY main_module, sub_module, child_module');
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('Error fetching permissions:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.updatePermission = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const { id } = req.params;
        const { Title, Route, Method, AccessText, main_module, sub_module, child_module, child_module_last } = req.body;

        const query = `
            UPDATE DOME.dbo.Permission
            SET Title = @Title, Route = @Route, Method = @Method, AccessText = @AccessText,
                main_module = @main_module, sub_module = @sub_module, child_module = @child_module,
                child_module_last = @child_module_last, UpdatedAt = GETDATE()
            WHERE Id = @Id
        `;

        request.input('Id', sql.Int, id);
        request.input('Title', sql.NVarChar, Title);
        request.input('Route', sql.NVarChar, Route);
        request.input('Method', sql.NVarChar, Method);
        request.input('AccessText', sql.NVarChar, AccessText);
        request.input('main_module', sql.NVarChar, main_module);
        request.input('sub_module', sql.NVarChar, sub_module || null);
        request.input('child_module', sql.NVarChar, child_module || null);
        request.input('child_module_last', sql.NVarChar, child_module_last || null);

        await request.query(query);
        res.json({ success: true, message: 'Permission updated successfully' });
    } catch (err) {
        console.error('Error updating permission:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.deletePermission = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const { id } = req.params;

        request.input('Id', sql.Int, id);
        await request.query('DELETE FROM DOME.dbo.Permission WHERE Id = @Id');

        res.json({ success: true, message: 'Permission deleted successfully' });
    } catch (err) {
        console.error('Error deleting permission:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getEmployeeById = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const { empid } = req.params;

        request.input('EmpID', sql.Int, empid);
        const result = await request.query(`
            SELECT empid as EmpID, FirstName, OfficeEmail, DepartmentName, Designationname 
            FROM HCM_GMS.dbo.MstEmployee 
            WHERE empid = @EmpID
        `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        res.json({ success: true, data: result.recordset[0] });
    } catch (err) {
        console.error('Error fetching employee:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getUserPermissions = async (req, res) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        const { empid } = req.params;

        request.input('EmpID', sql.Int, empid);
        const result = await request.query('SELECT PermissionId FROM DOME.dbo.UserPermission WHERE EmpID = @EmpID');
        
        const permissionIds = result.recordset.map(row => row.PermissionId);
        res.json({ success: true, data: permissionIds });
    } catch (err) {
        console.error('Error fetching user permissions:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.saveUserPermissions = async (req, res) => {
    try {
        const pool = await poolPromise;
        const { empid } = req.params;
        const { permissionIds } = req.body; // Array of IDs

        if (!Array.isArray(permissionIds)) {
            return res.status(400).json({ success: false, message: 'permissionIds must be an array' });
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const request = new sql.Request(transaction);
            request.input('EmpID', sql.Int, empid);
            
            // Delete existing
            await request.query('DELETE FROM DOME.dbo.UserPermission WHERE EmpID = @EmpID');

            // Insert new (if any)
            if (permissionIds.length > 0) {
                let values = [];
                for (let i = 0; i < permissionIds.length; i++) {
                    request.input(`Perm${i}`, sql.Int, permissionIds[i]);
                    values.push(`(@EmpID, @Perm${i})`);
                }
                const insertQuery = `INSERT INTO DOME.dbo.UserPermission (EmpID, PermissionId) VALUES ${values.join(', ')}`;
                await request.query(insertQuery);
            }

            await transaction.commit();
            res.json({ success: true, message: 'Permissions saved successfully' });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('Error saving user permissions:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
