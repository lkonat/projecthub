export default {
  id: 'personal',
  label: 'Personal',
  description: 'Personal projects, errands, or side experiments.',
  defaults: {
    priority: 'low',
  },
  fields: [
    { key: 'category', label: 'Category', type: 'select', required: false,
      options: ['errand', 'learning', 'health', 'hobby', 'other'] },
    { key: 'target_date', label: 'Target date', type: 'date', required: false },
  ],
};
