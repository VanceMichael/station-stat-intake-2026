export function newDispatcher(preset) {
  const accepted = new Set(preset.previous)
  const seen = new Set()
  return function viaDesk(request, url, edition) {
    const key = url.searchParams.get('client')
    const data = edition.streams
    const row = data.jobs.find(row => row[0] === key)
    const known = row && accepted.has(key)
    if (request.method === 'GET') {
      if (known) return {code:200, json:{status:'received', receipt:row}}
      if (preset.pending.includes(key) && !seen.has(key)) {
        seen.add(key)
        return {code:202, json:{status:'pending'}}
      }
      return {code:404, json:{status:'unknown'}}
    }
    if (request.method !== 'POST' || !row) return {code:422, json:{status:'unknown'}}
    if (known) return {code:202, json:{status:'received', receipt:row}}
    const [, station, shift] = row
    const max = data.quota.find(q => q[0] === station && q[1] === shift)?.[2]
    if (max === undefined) return {code:409, json:{status:'window-not-open'}}
    const used = data.jobs.filter(j => j[1] === station && j[2] === shift && accepted.has(j[0])).length
    if (used >= Number(max)) return {code:429, json:{status:'quota-exhausted'}}
    accepted.add(key)
    if (preset.ackLost.includes(key)) return {code:0}
    return {code:202, json:{status:'received', receipt:row}}
  }
}
