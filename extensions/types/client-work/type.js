// Example project type. Drop more files like this in extensions/types/
// to register new types. The default export must include `id` and `label`.

export default {
  id: 'client-work',
  label: 'Client work',
  description: 'Billable work for an external client.',
  defaults: {
    priority: 'high',
    status: 'active',
  },
  fields: [
    { key: 'client_name', label: 'Client name', type: 'text',     required: true },
    { key: 'budget_usd',  label: 'Budget (USD)', type: 'number',  required: false },
    { key: 'deadline',    label: 'Deadline',    type: 'date',     required: true },
    { key: 'engagement',  label: 'Engagement',  type: 'select',   required: true,
      options: ['fixed-bid', 'hourly', 'retainer'] },
    { key: 'notes',       label: 'Notes',       type: 'textarea', required: false },
  ],
};
