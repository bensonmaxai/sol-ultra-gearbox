if (
  .pass == true and
  (.roleChecks | type) == "array" and
  (.roleChecks | length) == 6
)
then
  {pass: .pass, roleCount: (.roleChecks | length)},
  ("GEARBOX" + "_" + "DOCTOR" + "_" + "PASS")
else
  error("doctor verification failed")
end
