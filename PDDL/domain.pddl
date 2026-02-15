(define (domain default)
    (:requirements :strips)
    (:predicates
        (up ?to ?from)
        (down ?to ?from)
        (left ?to ?from)
        (right ?to ?from)

        (at ?t)

        (parcel_at ?p ?t)
        (carrying ?p)
    )

    (:action move-up
        :parameters (?from ?to)
        :precondition (and (at ?from) (up ?to ?from))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-down
        :parameters (?from ?to)
        :precondition (and (at ?from) (down ?to ?from))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-left
        :parameters (?from ?to)
        :precondition (and (at ?from) (left ?to ?from))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-right
        :parameters (?from ?to)
        :precondition (and (at ?from) (right ?to ?from))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action pick-up
        :parameters (?p ?t)
        :precondition (and (at ?t) (parcel_at ?p ?t))
        :effect (and (carrying ?p) (not (parcel_at ?p ?t)))
    )

    (:action put-down
        :parameters (?p ?t)
        :precondition (and (at ?t) (carrying ?p))
        :effect (and (parcel_at ?p ?t) (not (carrying ?p)))
    )
)
