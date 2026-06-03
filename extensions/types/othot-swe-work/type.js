// Example project type. Drop more files like this in extensions/types/
// to register new types. The default export must include `id` and `label`.

export default {
  id: 'othot-swe-work',
  label: 'othot-swe-work',
  description: 'othot swe projects',
  defaults: {
    priority: 'high',
    status: 'active',
  },
  fields: [
    { key: 'gitClone',     label: 'Git Clone Name', type: 'text', required: true },
    { key: 'remoteGitClone',     label: 'Remote Clone Name', type: 'text', required: true },
    // Set by the Clone button after the repository is checked out locally.
    // Optional because it doesn't exist until the user clicks Clone.
    // { key: 'gitClone', label: 'repo path', type: 'text', required: false },
    // { key: 'budget_usd',  label: 'Budget (USD)', type: 'number',  required: false },
    // { key: 'deadline',    label: 'Deadline',    type: 'date',     required: true },
    // { key: 'engagement',  label: 'Engagement',  type: 'select',   required: true,
    //   options: ['fixed-bid', 'hourly', 'retainer'] },
    // { key: 'notes',       label: 'Notes',       type: 'textarea', required: false },
  ],
};
