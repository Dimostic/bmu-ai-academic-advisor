const { query } = require('../../config/db');

class FAQCategory {
    /**
     * Create a new category
     */
    static async create({ name, description, icon, displayOrder }) {
        const result = await query(
            `INSERT INTO faq_categories (name, description, icon, display_order)
             VALUES (?, ?, ?, ?)`,
            [name, description || null, icon || 'fas fa-folder', displayOrder || 0]
        );
        return result.insertId;
    }

    /**
     * Find by ID
     */
    static async findById(id) {
        const rows = await query('SELECT * FROM faq_categories WHERE id = ?', [id]);
        return rows[0] || null;
    }

    /**
     * Get all active categories with Q&A counts
     */
    static async findAll(includeInactive = false) {
        const sql = `
            SELECT fc.*, 
                   COUNT(cq.id) as qa_count,
                   SUM(CASE WHEN cq.is_verified = TRUE THEN 1 ELSE 0 END) as verified_count
            FROM faq_categories fc
            LEFT JOIN cached_qa cq ON cq.category_id = fc.id AND cq.is_active = TRUE
            ${includeInactive ? '' : 'WHERE fc.is_active = TRUE'}
            GROUP BY fc.id
            ORDER BY fc.display_order ASC, fc.name ASC
        `;
        return await query(sql);
    }

    /**
     * Update a category
     */
    static async update(id, { name, description, icon, displayOrder, isActive }) {
        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (icon !== undefined) { updates.push('icon = ?'); params.push(icon); }
        if (displayOrder !== undefined) { updates.push('display_order = ?'); params.push(displayOrder); }
        if (isActive !== undefined) { updates.push('is_active = ?'); params.push(isActive); }

        if (updates.length === 0) return false;

        params.push(id);
        await query(`UPDATE faq_categories SET ${updates.join(', ')} WHERE id = ?`, params);
        return true;
    }

    /**
     * Delete a category (soft delete by deactivating)
     */
    static async delete(id) {
        await query('UPDATE faq_categories SET is_active = FALSE WHERE id = ?', [id]);
        return true;
    }

    /**
     * Get category stats
     */
    static async getStats() {
        const rows = await query(`
            SELECT 
                fc.id, fc.name, fc.icon,
                COUNT(cq.id) as total_qa,
                SUM(cq.usage_count) as total_usage,
                SUM(CASE WHEN cq.is_verified THEN 1 ELSE 0 END) as verified_qa
            FROM faq_categories fc
            LEFT JOIN cached_qa cq ON cq.category_id = fc.id AND cq.is_active = TRUE
            WHERE fc.is_active = TRUE
            GROUP BY fc.id
            ORDER BY total_usage DESC
        `);
        return rows;
    }
}

module.exports = FAQCategory;
