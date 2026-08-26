function r(){return typeof crypto<"u"&&"randomUUID"in crypto?crypto.randomUUID():`id-${Date.now()}-${Math.random().toString(16).slice(2)}`}export{r as c};
